
export interface Tag {
    id: string;
    name: string;
}

export interface WorkflowStatus {
    id: string;
    name: string;
    order: number;
}

export interface Ticket {
    id: string;
    title: string;
    description: string;
    tagIds: string[];
    statusId: string;
    order: number;
    priority: number;
    createdAt: string;
    updatedAt: string;
    dueDate: string | null;
}

export interface Board {
    schemaVersion: number;
    tags: Tag[];
    statuses: WorkflowStatus[];
    tickets: Ticket[];
}

/**
 * TuolaFlowVSCode MVP 產品規則。
 * 狀態數量限制集中管理，不散落在 UI 或服務中。
 */
export const PRODUCT_RULES = {
    schemaVersion: 4,
    minStatuses: 2,
    maxStatuses: 8
} as const;

export function createInitialBoard(): Board {
    const initialStatuses = ['待辦事項', '處理中', '完成'];

    return {
        schemaVersion: PRODUCT_RULES.schemaVersion,
        tags: [],
        statuses: initialStatuses.map((name, order) => ({
            id: createId(),
            name,
            order
        })),
        tickets: []
    };
}

/**
 * 建立 UUID v4。
 * 使用 Node.js 內建 crypto，不增加第三方依賴。
 */
export function createId(): string {
    return require('node:crypto').randomUUID();
}

/**
 * 產生 UTC ISO 8601 時間。
 */
export function createTimestamp(): string {
    return new Date().toISOString();
}
