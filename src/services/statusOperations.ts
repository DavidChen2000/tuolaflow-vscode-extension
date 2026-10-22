import {
    createId,
    PRODUCT_RULES,
    type Board,
    type WorkflowStatus
} from '../models/board';

type StatusDirection = 'up' | 'down';

function parseStatusName(name: unknown, statuses: WorkflowStatus[], currentId?: string): string {
    if (typeof name !== 'string' || !name.trim()) {
        throw new Error('狀態名稱不可為空。');
    }

    const normalizedName = name.trim().toLowerCase();
    if (statuses.some((status) =>
        status.id !== currentId &&
        status.name.trim().toLowerCase() === normalizedName
    )) {
        throw new Error(`狀態名稱重複：${name.trim()}`);
    }

    return name.trim();
}

function orderedStatuses(board: Board): WorkflowStatus[] {
    return [...board.statuses].sort((left, right) => left.order - right.order);
}

function withOrderedStatuses(board: Board, statuses: WorkflowStatus[]): Board {
    return {
        ...board,
        statuses: statuses.map((status, order) => ({ ...status, order }))
    };
}

export function addStatusToBoard(board: Board, name: unknown): Board {
    if (board.statuses.length >= PRODUCT_RULES.maxStatuses) {
        throw new Error(
            `狀態數量已達上限 ${PRODUCT_RULES.maxStatuses} 個。`
        );
    }

    const statusName = parseStatusName(name, board.statuses);
    const statuses = orderedStatuses(board);
    statuses.push({
        id: createId(),
        name: statusName,
        order: statuses.length
    });

    return withOrderedStatuses(board, statuses);
}

export function renameStatusOnBoard(
    board: Board,
    statusId: string,
    name: unknown
): Board {
    const existing = board.statuses.find((status) => status.id === statusId);
    if (!existing) {
        throw new Error('找不到要重新命名的狀態，請重新整理看板。');
    }

    const statusName = parseStatusName(name, board.statuses, statusId);
    return {
        ...board,
        statuses: board.statuses.map((status) => status.id === statusId
            ? { ...status, name: statusName }
            : status)
    };
}

export function moveStatusOnBoard(
    board: Board,
    statusId: string,
    direction: unknown
): Board {
    if (direction !== 'up' && direction !== 'down') {
        throw new Error('狀態排序方向無效。');
    }

    const statuses = orderedStatuses(board);
    const index = statuses.findIndex((status) => status.id === statusId);
    if (index < 0) {
        throw new Error('找不到要排序的狀態，請重新整理看板。');
    }

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= statuses.length) {
        throw new Error('狀態已位於此方向的最前或最後位置。');
    }

    [statuses[index], statuses[targetIndex]] = [
        statuses[targetIndex],
        statuses[index]
    ];

    return withOrderedStatuses(board, statuses);
}

export function deleteStatusFromBoard(
    board: Board,
    statusId: string
): Board {
    const existing = board.statuses.find((status) => status.id === statusId);
    if (!existing) {
        throw new Error('找不到要刪除的狀態，請重新整理看板。');
    }

    if (board.tickets.some((ticket) => ticket.statusId === statusId)) {
        throw new Error('此狀態仍有任務，請先移動或刪除其中的任務再刪除狀態。');
    }

    if (board.statuses.length <= PRODUCT_RULES.minStatuses) {
        throw new Error(
            `看板至少需要 ${PRODUCT_RULES.minStatuses} 個狀態。`
        );
    }

    return withOrderedStatuses(
        board,
        orderedStatuses(board).filter((status) => status.id !== statusId)
    );
}

export function isStatusDirection(value: unknown): value is StatusDirection {
    return value === 'up' || value === 'down';
}
