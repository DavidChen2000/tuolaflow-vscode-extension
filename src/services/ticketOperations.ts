import {
    createId,
    type Board,
    type Ticket
} from '../models/board';

interface TicketInput {
    title: string;
    description: string;
    tagIds: string[];
    statusId: string;
    priority: number;
    dueDate: string | null;
}

function parseTicketInput(
    input: unknown,
    board: Board,
    defaultPriority = 0
): TicketInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('任務資料格式錯誤。');
    }

    const data = input as Record<string, unknown>;
    const title = typeof data.title === 'string' ? data.title.trim() : '';

    if (!title) {
        throw new Error('請輸入任務標題。');
    }

    if (typeof data.description !== 'string') {
        throw new Error('任務描述格式錯誤。');
    }

    if (
        !Array.isArray(data.tagIds) ||
        data.tagIds.some((tagId) =>
            typeof tagId !== 'string' ||
            !board.tags.some((tag) => tag.id === tagId)
        ) ||
        new Set(data.tagIds).size !== data.tagIds.length
    ) {
        throw new Error('請選擇有效且不重複的標籤。');
    }

    if (
        typeof data.statusId !== 'string' ||
        !board.statuses.some((item) => item.id === data.statusId)
    ) {
        throw new Error('請選擇有效的任務狀態。');
    }

    const priority = data.priority === undefined
        ? defaultPriority
        : data.priority;
    if (
        typeof priority !== 'number' ||
        !Number.isInteger(priority) ||
        priority < 0 ||
        priority > 3
    ) {
        throw new Error('請選擇有效的任務優先序。');
    }

    if (
        data.dueDate !== null &&
        (
            typeof data.dueDate !== 'string' ||
            !isValidDateOnly(data.dueDate)
        )
    ) {
        throw new Error('請輸入有效的到期日或留空。');
    }

    return {
        title,
        description: data.description,
        tagIds: data.tagIds as string[],
        statusId: data.statusId,
        priority,
        dueDate: data.dueDate as string | null
    };
}

function isValidDateOnly(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function nextOrder(board: Board, statusId: string): number {
    const orders = board.tickets
        .filter((ticket) => ticket.statusId === statusId)
        .map((ticket) => ticket.order);

    return orders.length ? Math.max(...orders) + 1 : 0;
}

export function createTicketOnBoard(
    board: Board,
    input: unknown
): Board {
    const fields = parseTicketInput(input, board);
    const now = new Date().toISOString();
    const ticket: Ticket = {
        ...fields,
        id: createId(),
        order: nextOrder(board, fields.statusId),
        priority: fields.priority,
        createdAt: now,
        updatedAt: now
    };

    return { ...board, tickets: [...board.tickets, ticket] };
}

export function setTicketPriorityOnBoard(
    board: Board,
    ticketId: string,
    priority: number
): Board {
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
        throw new Error('任務優先級必須是 0 到 3 的整數。');
    }

    const existing = board.tickets.find((ticket) => ticket.id === ticketId);
    if (!existing) {
        throw new Error('找不到要更新優先級的任務，請重新整理看板。');
    }
    if (existing.priority === priority) return board;

    const updatedAt = new Date(
        Math.max(Date.now(), Date.parse(existing.createdAt))
    ).toISOString();
    return {
        ...board,
        tickets: board.tickets.map((ticket) => ticket.id === ticketId
            ? { ...ticket, priority, updatedAt }
            : ticket)
    };
}

export function updateTicketOnBoard(
    board: Board,
    ticketId: string,
    input: unknown
): Board {
    const existing = board.tickets.find((ticket) => ticket.id === ticketId);

    if (!existing) {
        throw new Error('找不到要編輯的任務，請重新整理看板。');
    }

    const fields = parseTicketInput(input, board, existing.priority);
    const order = fields.statusId === existing.statusId
        ? existing.order
        : nextOrder(board, fields.statusId);
    const updatedAt = new Date(
        Math.max(Date.now(), Date.parse(existing.createdAt))
    ).toISOString();

    return {
        ...board,
        tickets: board.tickets.map((ticket) => ticket.id === ticketId
            ? { ...ticket, ...fields, order, updatedAt }
            : ticket)
    };
}

export function deleteTicketFromBoard(
    board: Board,
    ticketId: string
): Board {
    if (!board.tickets.some((ticket) => ticket.id === ticketId)) {
        throw new Error('找不到要刪除的任務，請重新整理看板。');
    }

    return {
        ...board,
        tickets: board.tickets.filter((ticket) => ticket.id !== ticketId)
    };
}

export function reorderTicketOnBoard(
    board: Board,
    ticketId: string,
    destinationStatusId: string,
    destinationIndex: number
): Board {
    const movingTicket = board.tickets.find((ticket) => ticket.id === ticketId);
    if (!movingTicket) {
        throw new Error('找不到要移動的任務，請重新整理看板。');
    }

    if (!board.statuses.some((status) => status.id === destinationStatusId)) {
        throw new Error('目標狀態不存在，請重新整理看板。');
    }

    if (!Number.isInteger(destinationIndex) || destinationIndex < 0) {
        throw new Error('任務排序位置無效。');
    }

    const originalOrder = new Map(
        board.tickets.map((ticket) => [ticket.id, {
            statusId: ticket.statusId,
            order: ticket.order
        }])
    );
    const sourceTickets = board.tickets
        .filter((ticket) => ticket.statusId === movingTicket.statusId && ticket.id !== ticketId)
        .sort((left, right) => left.order - right.order);
    const destinationTickets = movingTicket.statusId === destinationStatusId
        ? sourceTickets
        : board.tickets
            .filter((ticket) => ticket.statusId === destinationStatusId)
            .sort((left, right) => left.order - right.order);

    if (destinationIndex > destinationTickets.length) {
        throw new Error('任務排序位置超出目標欄位範圍。');
    }

    destinationTickets.splice(destinationIndex, 0, movingTicket);
    const now = new Date().toISOString();
    const updatedOrders = new Map<string, { statusId: string; order: number }>();

    if (movingTicket.statusId !== destinationStatusId) {
        sourceTickets.forEach((ticket, order) => {
            updatedOrders.set(ticket.id, { statusId: ticket.statusId, order });
        });
    }

    destinationTickets.forEach((ticket, order) => {
        updatedOrders.set(ticket.id, { statusId: destinationStatusId, order });
    });

    return {
        ...board,
        tickets: board.tickets.map((ticket) => {
            const position = updatedOrders.get(ticket.id);
            if (!position) return ticket;

            const previous = originalOrder.get(ticket.id);
            if (
                previous?.statusId === position.statusId &&
                previous.order === position.order
            ) {
                return ticket;
            }

            return {
                ...ticket,
                statusId: position.statusId,
                order: position.order,
                updatedAt: now
            };
        })
    };
}
