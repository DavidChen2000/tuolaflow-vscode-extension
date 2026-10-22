import type { Ticket } from '../models/board';

interface TicketCardTag {
    name: string;
}

export function renderTicketCard(
    ticket: Ticket,
    tags: TicketCardTag[],
    draggable = false
): string {
    const editData: Array<[string, string]> = [
        ['title', ticket.title],
        ['description', ticket.description],
        ['tagIds', JSON.stringify(ticket.tagIds)],
        ['statusId', ticket.statusId],
        ['dueDate', ticket.dueDate ?? '']
    ];
    const priorityNames = ['最低', '低', '中', '最高'];
    const priorityName = priorityNames[ticket.priority] ?? '未知';

    const editAttributes = editData
        .map(([field, value]) =>
            `data-${toKebabCase(field)}="${escapeHtml(value)}"`
        )
        .join(' ');

    return `
        <article class="task" data-ticket-id="${escapeHtml(ticket.id)}"
            draggable="${draggable}" data-order="${ticket.order}"
            data-created-at="${escapeHtml(ticket.createdAt)}"
            data-priority="${ticket.priority}"
            aria-label="任務「${escapeHtml(ticket.title)}」，按 Enter 開啟編輯"
            tabindex="0" ${editAttributes}>
            <div class="task-heading">
                <button class="priority-dot priority-${ticket.priority}" type="button"
                    data-priority-ticket-id="${escapeHtml(ticket.id)}"
                    data-priority="${ticket.priority}"
                    aria-label="優先級 ${ticket.priority}（${priorityName}），點擊變更"
                    title="優先級 ${ticket.priority}（${priorityName}），點擊循環變更"></button>
                <div class="task-title">${escapeHtml(ticket.title)}</div>
                <details class="task-menu">
                    <summary class="task-menu-toggle" aria-label="任務功能選單"
                        title="任務功能選單">⋯</summary>
                    <div class="task-menu-panel floating-menu-panel">
                        <button class="task-menu-option primary-button" type="button"
                            data-edit-ticket="${escapeHtml(ticket.id)}"
                            aria-label="編輯「${escapeHtml(ticket.title)}」">編輯</button>
                        <button class="task-menu-option success-button" type="button"
                            data-copy-ticket="${escapeHtml(ticket.id)}">複製</button>
                        <button class="task-menu-option danger-button" type="button"
                            data-delete-ticket="${escapeHtml(ticket.id)}"
                            aria-label="刪除「${escapeHtml(ticket.title)}」">刪除</button>
                    </div>
                </details>
            </div>
            ${ticket.description
                ? `<div class="task-description">${escapeHtml(ticket.description)}</div>`
                : ''}
            ${ticket.dueDate
                ? `<div class="task-meta">📅 到期日：${escapeHtml(ticket.dueDate)}</div>`
                : ''}
            ${tags.length
                ? `<div class="task-tags">${tags.map((tag) =>
                    `<span class="task-tag">${escapeHtml(tag.name)}</span>`
                ).join('')}</div>`
                : ''}
        </article>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char] ?? char);
}

function toKebabCase(value: string): string {
    return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
