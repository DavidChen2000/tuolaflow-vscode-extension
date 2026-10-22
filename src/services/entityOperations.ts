import {
    createId,
    type Board,
    type Tag
} from '../models/board';

function requiredName(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label}不可為空。`);
    }

    return value.trim();
}

function normalized(value: string): string {
    return value.trim().toLowerCase();
}

function parseTag(
    board: Board,
    input: unknown,
    currentId?: string
): Pick<Tag, 'name'> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('標籤資料格式錯誤。');
    }

    const data = input as Record<string, unknown>;
    const name = requiredName(data.name, '標籤名稱');

    if (board.tags.some((tag) =>
        tag.id !== currentId &&
        normalized(tag.name) === normalized(name)
    )) {
        throw new Error(`已有相同標籤：${name}`);
    }

    return { name };
}

export function addTagToBoard(board: Board, input: unknown): Board {
    const fields = parseTag(board, input);
    return {
        ...board,
        tags: [...board.tags, { id: createId(), ...fields }]
    };
}

export function updateTagOnBoard(
    board: Board,
    tagId: string,
    input: unknown
): Board {
    if (!board.tags.some((tag) => tag.id === tagId)) {
        throw new Error('找不到要編輯的標籤，請重新整理看板。');
    }

    const fields = parseTag(board, input, tagId);
    return {
        ...board,
        tags: board.tags.map((tag) =>
            tag.id === tagId ? { ...tag, ...fields } : tag
        )
    };
}

export function deleteTagFromBoard(board: Board, tagId: string): Board {
    if (!board.tags.some((tag) => tag.id === tagId)) {
        throw new Error('找不到要刪除的標籤，請重新整理看板。');
    }

    return {
        ...board,
        tags: board.tags.filter((tag) => tag.id !== tagId),
        tickets: board.tickets.map((ticket) => {
            if (!ticket.tagIds.includes(tagId)) {
                return ticket;
            }

            return {
                ...ticket,
                tagIds: ticket.tagIds.filter((id) => id !== tagId),
                updatedAt: new Date(
                    Math.max(Date.now(), Date.parse(ticket.createdAt))
                ).toISOString()
            };
        })
    };
}
