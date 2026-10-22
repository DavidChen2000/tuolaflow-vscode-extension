import type { Ticket } from '../models/board';

export type TicketSortMode = 'manual' | 'title' | 'dueDate' | 'priority';

export function isTicketSortMode(value: unknown): value is TicketSortMode {
    return value === 'manual' || value === 'title' || value === 'dueDate' ||
        value === 'priority';
}

export function sortTickets(
    tickets: readonly Ticket[],
    mode: TicketSortMode
): Ticket[] {
    return [...tickets].sort((left, right) => {
        if (mode === 'title') {
            const titleOrder = left.title.localeCompare(right.title, 'zh-Hant');
            if (titleOrder !== 0) return titleOrder;
        } else if (mode === 'dueDate') {
            if (left.dueDate === null && right.dueDate !== null) return 1;
            if (left.dueDate !== null && right.dueDate === null) return -1;
            const dateOrder = (left.dueDate ?? '').localeCompare(right.dueDate ?? '');
            if (dateOrder !== 0) return dateOrder;
        } else if (mode === 'priority') {
            const priorityOrder = right.priority - left.priority;
            if (priorityOrder !== 0) return priorityOrder;
        }

        return left.order - right.order;
    });
}
