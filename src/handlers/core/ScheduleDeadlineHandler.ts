import { CallToolResult, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { calendar_v3 } from 'googleapis';
import { createStructuredResponse } from "../../utils/response-builder.js";
import { convertGoogleEventToStructured } from "../../types/structured-responses.js";

interface TimeSlot {
    start: Date;
    end: Date;
}

interface BusyPeriod {
    start: string;
    end: string;
}

export class ScheduleDeadlineHandler extends BaseToolHandler {
    async runTool(args: any, accounts: Map<string, OAuth2Client>): Promise<CallToolResult> {
        // 1. Resolve account & calendar
        const { client: oauth2Client, accountId: selectedAccountId, calendarId: resolvedCalendarId } =
            await this.getClientWithAutoSelection(args.account, args.calendarId || 'primary', accounts, 'write');

        // 2. Parse and validate dates
        const timezone = args.timeZone || await this.getCalendarTimezone(oauth2Client, resolvedCalendarId);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const startDate = args.startDate ? new Date(args.startDate) : new Date(today);
        const deadlineDate = new Date(args.deadline);
        deadlineDate.setHours(23, 59, 59, 999);

        if (deadlineDate < today) {
            throw new McpError(ErrorCode.InvalidRequest, 'Deadline must be today or in the future');
        }

        // 3. Calculate sessions needed
        const sessionDurationHours = args.sessionDurationHours ?? 2;
        const totalSessions = Math.ceil(args.estimatedHours / sessionDurationHours);

        // 4. Get free/busy data across ALL calendars in ALL accounts so sessions
        //    never overlap with any existing event (school, sports, personal, etc.)
        const busySlots = await this.getAllAccountsBusy(accounts, startDate, deadlineDate);

        // 5. Find available slots
        const preferredStartTime = args.preferredStartTime || '16:00';
        const preferredEndTime = args.preferredEndTime || '21:00';
        const availableSlots = this.findAvailableSlots(
            startDate, deadlineDate, busySlots,
            totalSessions, sessionDurationHours,
            preferredStartTime, preferredEndTime
        );

        // 6. Create calendar events
        const calendar = this.getCalendar(oauth2Client);
        const createdEvents: calendar_v3.Schema$Event[] = [];

        for (let i = 0; i < availableSlots.length; i++) {
            const slot = availableSlots[i];
            const sessionNumber = i + 1;
            const event = await this.createStudyEvent(
                calendar, resolvedCalendarId, args, slot, sessionNumber, availableSlots.length, timezone
            );
            createdEvents.push(event);
        }

        // 7. Build response
        const scheduled = createdEvents.length;
        const unscheduled = totalSessions - scheduled;
        const warnings: string[] = [];
        if (unscheduled > 0) {
            warnings.push(
                `Could not schedule ${unscheduled} of ${totalSessions} sessions — your calendar is too full in that time window. ` +
                `Try adjusting preferredStartTime/preferredEndTime or freeing up time before the deadline.`
            );
        }

        return createStructuredResponse({
            task: {
                name: args.taskName,
                type: args.taskType,
                deadline: args.deadline,
                estimatedHours: args.estimatedHours,
                sessionDurationHours,
                sessionsNeeded: totalSessions,
                sessionsScheduled: scheduled,
                sessionsUnscheduled: unscheduled,
                calendarId: resolvedCalendarId,
                account: selectedAccountId,
            },
            events: createdEvents.map(e => convertGoogleEventToStructured(e, resolvedCalendarId, selectedAccountId)),
            warnings,
        });
    }

    // Queries free/busy across every calendar in every authenticated account and
    // merges all busy periods into one flat list. This ensures study sessions
    // never clash with school events, sports, or any other calendar.
    private async getAllAccountsBusy(
        accounts: Map<string, OAuth2Client>,
        start: Date,
        end: Date
    ): Promise<BusyPeriod[]> {
        const allBusy: BusyPeriod[] = [];

        for (const [, client] of accounts) {
            const calendarIds = await this.listCalendarIds(client);
            const calendar = this.getCalendar(client);
            try {
                const response = await calendar.freebusy.query({
                    requestBody: {
                        timeMin: start.toISOString(),
                        timeMax: end.toISOString(),
                        items: calendarIds.map(id => ({ id })),
                    },
                });
                for (const id of calendarIds) {
                    const busy = response.data.calendars?.[id]?.busy || [];
                    allBusy.push(...(busy as BusyPeriod[]));
                }
            } catch {
                // If one account fails, skip it and continue with the rest
            }
        }

        return allBusy;
    }

    private async listCalendarIds(client: OAuth2Client): Promise<string[]> {
        const calendar = this.getCalendar(client);
        try {
            const response = await calendar.calendarList.list({ minAccessRole: 'reader' });
            return (response.data.items || [])
                .map(c => c.id)
                .filter((id): id is string => Boolean(id));
        } catch {
            return ['primary'];
        }
    }

    private findAvailableSlots(
        startDate: Date,
        deadlineDate: Date,
        busySlots: BusyPeriod[],
        totalSessions: number,
        sessionDurationHours: number,
        preferredStart: string,
        preferredEnd: string
    ): TimeSlot[] {
        const slots: TimeSlot[] = [];
        const sessionMs = sessionDurationHours * 60 * 60 * 1000;

        const sortedBusy = [...busySlots].sort(
            (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
        );

        const current = new Date(startDate);
        current.setHours(0, 0, 0, 0);

        const [startHour, startMin] = preferredStart.split(':').map(Number);
        const [endHour, endMin] = preferredEnd.split(':').map(Number);

        while (current < deadlineDate && slots.length < totalSessions) {
            const windowStart = new Date(current);
            windowStart.setHours(startHour, startMin, 0, 0);

            const windowEnd = new Date(current);
            windowEnd.setHours(endHour, endMin, 0, 0);

            const freeSlot = this.findFirstFreeSlot(windowStart, windowEnd, sortedBusy, sessionMs);
            if (freeSlot) {
                slots.push(freeSlot);
            }

            current.setDate(current.getDate() + 1);
        }

        return slots;
    }

    private findFirstFreeSlot(
        windowStart: Date,
        windowEnd: Date,
        busySlots: BusyPeriod[],
        durationMs: number
    ): TimeSlot | null {
        let cursor = new Date(windowStart);

        for (const busy of busySlots) {
            const busyStart = new Date(busy.start);
            const busyEnd = new Date(busy.end);

            if (busyEnd <= cursor || busyStart >= windowEnd) continue;

            // Check gap before this busy period
            if (busyStart > cursor) {
                const gapEnd = new Date(Math.min(busyStart.getTime(), windowEnd.getTime()));
                if (gapEnd.getTime() - cursor.getTime() >= durationMs) {
                    return { start: new Date(cursor), end: new Date(cursor.getTime() + durationMs) };
                }
            }

            if (busyEnd > cursor) {
                cursor = new Date(busyEnd);
            }
        }

        // Check remaining time
        if (windowEnd.getTime() - cursor.getTime() >= durationMs) {
            return { start: new Date(cursor), end: new Date(cursor.getTime() + durationMs) };
        }

        return null;
    }

    private async createStudyEvent(
        calendar: ReturnType<typeof this.getCalendar>,
        calendarId: string,
        args: any,
        slot: TimeSlot,
        sessionNumber: number,
        totalSessions: number,
        timezone: string
    ): Promise<calendar_v3.Schema$Event> {
        const typeEmoji: Record<string, string> = {
            IA: '📝', EE: '📚', exam: '🎯', other: '✏️'
        };
        const emoji = typeEmoji[args.taskType] || '✏️';
        const summary = `${emoji} ${args.taskName} — Session ${sessionNumber}/${totalSessions}`;

        const eventBody: calendar_v3.Schema$Event = {
            summary,
            description: `Study session for ${args.taskType.toUpperCase()}: ${args.taskName}\nDeadline: ${args.deadline}\nSession ${sessionNumber} of ${totalSessions}`,
            start: {
                dateTime: slot.start.toISOString(),
                timeZone: timezone,
            },
            end: {
                dateTime: slot.end.toISOString(),
                timeZone: timezone,
            },
            colorId: args.colorId,
            reminders: {
                useDefault: false,
                overrides: [{ method: 'popup', minutes: 15 }],
            },
            extendedProperties: {
                private: {
                    ibDeadlineTask: args.taskName,
                    ibDeadlineType: args.taskType,
                    ibDeadlineDate: args.deadline,
                    ibScheduledSession: 'true',
                },
            },
        };

        try {
            const response = await calendar.events.insert({
                calendarId,
                requestBody: eventBody,
            });
            return response.data;
        } catch (error) {
            throw this.handleGoogleApiError(error);
        }
    }
}
