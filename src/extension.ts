
import * as vscode from 'vscode';
import * as path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createInitialBoard, PRODUCT_RULES, type Board } from './models/board';
import { createBoardFile, loadBoard, saveBoard } from './services/boardStorage';
import {
    createTicketOnBoard,
    deleteTicketFromBoard,
    reorderTicketOnBoard,
    setTicketPriorityOnBoard,
    updateTicketOnBoard
} from './services/ticketOperations';
import { renderTicketCard } from './services/ticketCardRenderer';
import {
    isTicketSortMode,
    sortTickets,
    type TicketSortMode
} from './services/ticketSorting';
import {
    addStatusToBoard,
    deleteStatusFromBoard,
    renameStatusOnBoard
} from './services/statusOperations';
import {
    addTagToBoard,
    deleteTagFromBoard,
    updateTagOnBoard
} from './services/entityOperations';

const boardPathStorageKey = 'tuolaflow.boardPath';
let activeBoardPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const searchTasksCommand = vscode.commands.registerCommand(
        'tuolaflow.searchTasks',
        () => activeBoardPanel?.webview.postMessage({ type: 'openSearchDialog' })
    );

    const boardViewProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
        getTreeItem(element) {
            return element;
        },
        getChildren() {
            return [new vscode.TreeItem(
                '正在開啟 TuolaFlow 任務看板…',
                vscode.TreeItemCollapsibleState.None
            )];
        }
    };

    const boardView = vscode.window.createTreeView(
        'tuolaflow.board',
        { treeDataProvider: boardViewProvider }
    );
    let openingBoardFromActivityBar = false;
    const openBoardFromActivityBar = async (): Promise<void> => {
        if (openingBoardFromActivityBar) return;
        openingBoardFromActivityBar = true;
        try {
            await vscode.commands.executeCommand('tuolaflow.openBoard');
        } catch (error) {
            void vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error)
            );
        } finally {
            try {
                if (boardView.visible) {
                    await vscode.commands.executeCommand(
                        'workbench.action.toggleSidebarVisibility'
                    );
                }
            } finally {
                openingBoardFromActivityBar = false;
            }
        }
    };

    const openBoardCommand = vscode.commands.registerCommand(
        'tuolaflow.openBoard',
        async () => {
            const panel = vscode.window.createWebviewPanel(
                'tuolaflow.boardPanel',
                'TuolaFlow 任務看板',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            activeBoardPanel = panel;
            panel.onDidChangeViewState(() => {
                if (panel.active) {
                    activeBoardPanel = panel;
                }
            });
            panel.onDidDispose(() => {
                if (activeBoardPanel === panel) {
                    activeBoardPanel = undefined;
                }
            });

            let board: Board;
            let boardPath: string;

            try {
                const preferredPath = context.globalState.get<string>(boardPathStorageKey);
                let defaultPath = preferredPath;
                if (!defaultPath || !await isReadableBoardFile(defaultPath)) {
                    defaultPath = await getDefaultBoardPath();
                }
                if (!defaultPath) {
                    panel.dispose();
                    return;
                }
                boardPath = defaultPath;

                if (!await isReadableBoardFile(boardPath)) {
                    if (await isBoardFileMissing(boardPath)) {
                        const initialBoard = createInitialBoard();
                        try {
                            await createBoardFile(boardPath, initialBoard);
                            board = initialBoard;
                        } catch (error) {
                            if (
                                (error as NodeJS.ErrnoException).code !== 'EEXIST'
                            ) {
                                throw error;
                            }
                            board = await loadBoard(boardPath);
                        }
                    } else {
                        const selectedPath = await selectBoardFile(
                            path.dirname(boardPath)
                        );
                        if (!selectedPath) {
                            panel.dispose();
                            return;
                        }
                        boardPath = selectedPath;
                        board = await loadBoard(boardPath);
                    }
                } else {
                    board = await loadBoard(boardPath);
                }

                await context.globalState.update(boardPathStorageKey, boardPath);
            } catch (error) {
                panel.webview.html = getErrorHtml(
                    error instanceof Error ? error.message : String(error)
                );
                return;
            }

            const sortModes: Record<string, TicketSortMode> = {};
            const render = (notice?: string) => {
                panel.webview.html = getBoardHtml(board, notice, sortModes, boardPath);
            };

            panel.webview.onDidReceiveMessage(async (message) => {
                if (message?.type === 'copyTicket') {
                    try {
                        if (typeof message.ticketId !== 'string') {
                            throw new Error('任務識別碼格式錯誤。');
                        }
                        const ticket = board.tickets.find(
                            (item) => item.id === message.ticketId
                        );
                        if (!ticket) {
                            throw new Error('找不到要複製的任務。');
                        }
                        await vscode.env.clipboard.writeText(
                            `${ticket.title}\n${ticket.description}`
                        );
                        void panel.webview.postMessage({
                            type: 'ticketOperationResult',
                            success: true,
                            message: '任務內容已複製到剪貼簿。'
                        });
                    } catch (error) {
                        void panel.webview.postMessage({
                            type: 'ticketOperationResult',
                            success: false,
                            message: error instanceof Error
                                ? error.message
                                : String(error)
                        });
                    }
                    return;
                }

                if (message?.type === 'changeBoardLocation') {
                    try {
                        const selectedPath = await selectBoardFile(
                            path.dirname(boardPath)
                        );
                        if (!selectedPath) {
                            return;
                        }

                        const selectedBoard = await loadBoard(selectedPath);
                        await context.globalState.update(
                            boardPathStorageKey,
                            selectedPath
                        );
                        boardPath = selectedPath;
                        board = selectedBoard;
                        render('看板位置已更新。');
                    } catch (error) {
                        void panel.webview.postMessage({
                            type: 'ticketOperationResult',
                            success: false,
                            message: error instanceof Error
                                ? error.message
                                : String(error)
                        });
                    }
                    return;
                }

                if (message?.type === 'sortTickets') {
                    if (
                        typeof message.statusId !== 'string' ||
                        !board.statuses.some((status) => status.id === message.statusId) ||
                        !isTicketSortMode(message.mode)
                    ) {
                        void panel.webview.postMessage({
                            type: 'ticketOperationResult',
                            success: false,
                            message: '排序方式無效。'
                        });
                        return;
                    }

                    sortModes[message.statusId] = message.mode;
                    render();
                    return;
                }

                if (
                    message?.type !== 'createTicket' &&
                    message?.type !== 'updateTicket' &&
                    message?.type !== 'updateTicketPriority' &&
                    message?.type !== 'deleteTicket' &&
                    message?.type !== 'reorderTicket' &&
                    message?.type !== 'createStatus' &&
                    message?.type !== 'renameStatus' &&
                    message?.type !== 'deleteStatus' &&
                    message?.type !== 'createTag' &&
                    message?.type !== 'updateTag' &&
                    message?.type !== 'deleteTag'
                ) {
                    return;
                }

                try {
                    // 重新讀取最新資料，避免直接覆蓋外部已更新的內容。
                    const latestBoard = await loadBoard(boardPath);
                    let updatedBoard: Board;
                    let notice: string;

                    if (message.type === 'createTicket') {
                        updatedBoard = createTicketOnBoard(latestBoard, message);
                        notice = '任務已成功新增。';
                    } else if (message.type === 'createTag') {
                        updatedBoard = addTagToBoard(latestBoard, message);
                        notice = '標籤已成功新增。';
                    } else if (message.type === 'updateTag') {
                        if (typeof message.tagId !== 'string') {
                            throw new Error('標籤識別碼格式錯誤。');
                        }
                        updatedBoard = updateTagOnBoard(
                            latestBoard,
                            message.tagId,
                            message
                        );
                        notice = '標籤已更新。';
                    } else if (message.type === 'deleteTag') {
                        if (typeof message.tagId !== 'string') {
                            throw new Error('標籤識別碼格式錯誤。');
                        }
                        const tag = latestBoard.tags.find(
                            (item) => item.id === message.tagId
                        );
                        if (!tag) {
                            throw new Error('找不到要刪除的標籤，請重新整理看板。');
                        }
                        const confirmation = await vscode.window.showWarningMessage(
                            `若刪除此標籤，則相關任務卡片上的標籤都會被一併移除。確認刪除「${tag.name}」？`,
                            { modal: true },
                            '刪除'
                        );
                        if (confirmation !== '刪除') {
                            return;
                        }
                        updatedBoard = deleteTagFromBoard(latestBoard, message.tagId);
                        notice = '標籤已刪除。';
                    } else if (message.type === 'reorderTicket') {
                        if (
                            typeof message.ticketId !== 'string' ||
                            typeof message.statusId !== 'string' ||
                            typeof message.index !== 'number'
                        ) {
                            throw new Error('任務排序資料格式錯誤。');
                        }
                        updatedBoard = reorderTicketOnBoard(
                            latestBoard,
                            message.ticketId,
                            message.statusId,
                            message.index
                        );
                        notice = '任務順序已更新。';
                    } else if (message.type === 'updateTicketPriority') {
                        if (typeof message.ticketId !== 'string') {
                            throw new Error('任務識別碼格式錯誤。');
                        }
                        updatedBoard = setTicketPriorityOnBoard(
                            latestBoard,
                            message.ticketId,
                            message.priority
                        );
                        notice = '';
                    } else if (message.type === 'createStatus') {
                        updatedBoard = addStatusToBoard(
                            latestBoard,
                            message.name
                        );
                        notice = '狀態已成功新增。';
                    } else if (message.type === 'renameStatus') {
                        if (typeof message.statusId !== 'string') {
                            throw new Error('狀態識別碼格式錯誤。');
                        }
                        if (typeof message.name !== 'string') {
                            throw new Error('狀態名稱格式錯誤。');
                        }
                        updatedBoard = renameStatusOnBoard(
                            latestBoard,
                            message.statusId,
                            message.name
                        );
                        notice = '狀態已成功重新命名。';
                    } else if (message.type === 'deleteStatus') {
                        if (typeof message.statusId !== 'string') {
                            throw new Error('狀態識別碼格式錯誤。');
                        }
                        const status = latestBoard.statuses.find(
                            (item) => item.id === message.statusId
                        );
                        if (!status) {
                            throw new Error('找不到要刪除的狀態，請重新整理看板。');
                        }
                        updatedBoard = deleteStatusFromBoard(
                            latestBoard,
                            message.statusId
                        );
                        const confirmation = await vscode.window.showWarningMessage(
                            `確定要刪除狀態「${status.name}」嗎？此操作無法復原。`,
                            { modal: true },
                            '刪除'
                        );
                        if (confirmation !== '刪除') {
                            return;
                        }
                        notice = '狀態已成功刪除。';
                    } else {
                        if (message.type === 'updateTicket') {
                            if (typeof message.ticketId !== 'string') {
                                throw new Error('任務識別碼格式錯誤。');
                            }
                            updatedBoard = updateTicketOnBoard(
                                latestBoard,
                                message.ticketId,
                                message
                            );
                            notice = '任務已成功更新。';
                        } else if (message.type === 'deleteTicket') {
                            if (typeof message.ticketId !== 'string') {
                                throw new Error('任務識別碼格式錯誤。');
                            }
                            const ticket = latestBoard.tickets.find(
                                (item) => item.id === message.ticketId
                            );
                            if (!ticket) {
                                throw new Error('找不到要刪除的任務。');
                            }
                            const confirmation = await vscode.window.showWarningMessage(
                                `確定要刪除任務「${ticket.title}」嗎？此操作無法復原。`,
                                { modal: true },
                                '刪除'
                            );
                            if (confirmation !== '刪除') {
                                return;
                            }
                            updatedBoard = deleteTicketFromBoard(
                                latestBoard,
                                message.ticketId
                            );
                            notice = '任務已成功刪除。';
                        } else {
                            throw new Error('不支援的看板操作。');
                        }
                    }

                    await saveBoard(boardPath, updatedBoard);
                    board = updatedBoard;
                    render(notice);
                } catch (error) {
                    void panel.webview.postMessage({
                        type: 'ticketOperationResult',
                        success: false,
                        message: error instanceof Error
                            ? error.message
                            : String(error)
                    });
                }
            });


            render();
        }
    );

    const activityBarVisibility = boardView.onDidChangeVisibility((event) => {
        if (event.visible) {
            void openBoardFromActivityBar();
        }
    });
    if (boardView.visible) {
        void openBoardFromActivityBar();
    }

    context.subscriptions.push(
        boardView,
        activityBarVisibility,
        openBoardCommand,
        searchTasksCommand
    );
}

async function getDefaultBoardPath(): Promise<string | undefined> {
    const workspaces = vscode.workspace.workspaceFolders ?? [];
    if (workspaces.length === 1) {
        return path.join(workspaces[0].uri.fsPath, 'board.json');
    }

    if (workspaces.length > 1) {
        const activeDocument = vscode.window.activeTextEditor?.document.uri;
        const activeWorkspace = activeDocument
            ? vscode.workspace.getWorkspaceFolder(activeDocument)
            : undefined;
        if (activeWorkspace) {
            return path.join(activeWorkspace.uri.fsPath, 'board.json');
        }

        const selectedWorkspace = await vscode.window.showWorkspaceFolderPick({
            placeHolder: '選擇預設包含 board.json 的工作區資料夾'
        });
        if (!selectedWorkspace) {
            return undefined;
        }
        return path.join(selectedWorkspace.uri.fsPath, 'board.json');
    }

    const selectedPath = await selectBoardFile();
    return selectedPath;
}

async function isReadableBoardFile(filePath: string): Promise<boolean> {
    try {
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
            return false;
        }
        await access(filePath, fsConstants.R_OK);
        return true;
    } catch (error) {
        if (isBoardPathUnavailableError(error)) {
            return false;
        }
        throw error;
    }
}

async function isBoardFileMissing(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
        }
        throw error;
    }
}

function isBoardPathUnavailableError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) {
        return false;
    }
    return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(
        String(error.code)
    );
}

async function selectBoardFile(defaultDirectory?: string): Promise<string | undefined> {
    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: defaultDirectory ? vscode.Uri.file(defaultDirectory) : undefined,
        openLabel: '選擇 board.json',
        filters: { 'JSON 檔案': ['json'] }
    });
    return selected?.[0]?.fsPath;
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

function getBoardHtml(
    board: Board,
    notice?: string,
    sortModes: Record<string, TicketSortMode> = {},
    boardPath = ''
): string {
    const tags = new Map(board.tags.map((tag) => [tag.id, tag]));
    const statuses = [...board.statuses].sort(
        (a, b) => a.order - b.order
    );

    const columns = statuses.map((status) => {
        const sortMode = sortModes[status.id] ?? 'manual';
        const tickets = sortTickets(
            board.tickets.filter((ticket) => ticket.statusId === status.id),
            sortMode
        );

        const cards = tickets.length
            ? tickets.map((ticket) => renderTicketCard(
                ticket,
                ticket.tagIds.flatMap((tagId) => {
                    const tag = tags.get(tagId);
                    return tag ? [{
                        name: tag.name
                    }] : [];
                }),
                sortMode === 'manual'
            )).join('')
            : '<div class="empty">目前沒有任務</div>';

        return `
            <section class="column" data-status-id="${escapeHtml(status.id)}"
                data-sort-mode="${sortMode}">
                <div class="column-header">
                    <div class="column-title-group">
                        <button class="column-add-ticket" type="button"
                            data-create-ticket-status="${escapeHtml(status.id)}"
                            aria-label="新增任務至${escapeHtml(status.name)}"
                            title="新增任務至${escapeHtml(status.name)}">+</button>
                        <span>${escapeHtml(status.name)}</span>
                    </div>
                    <span class="column-header-actions">
                        <span class="count">${tickets.length}</span>
                        <details class="column-sort">
                            <summary class="sort-toggle" aria-label="排序任務"
                                title="排序任務">⇅</summary>
                            <div class="column-sort-panel floating-menu-panel">
                                <div class="menu-actions">
                                <button class="button" type="button"
                                    data-sort-status="${escapeHtml(status.id)}"
                                    data-sort-mode="manual"
                                    aria-pressed="${sortMode === 'manual'}">手動排序</button>
                                <button class="button" type="button"
                                    data-sort-status="${escapeHtml(status.id)}"
                                    data-sort-mode="title"
                                    aria-pressed="${sortMode === 'title'}">依標題排序</button>
                                <button class="button" type="button"
                                    data-sort-status="${escapeHtml(status.id)}"
                                    data-sort-mode="dueDate"
                                    aria-pressed="${sortMode === 'dueDate'}">依到期日排序</button>
                                <button class="button" type="button"
                                    data-sort-status="${escapeHtml(status.id)}"
                                    data-sort-mode="priority"
                                    aria-pressed="${sortMode === 'priority'}">依優先級排序</button>
                                </div>
                            </div>
                        </details>
                    </span>
                </div>
                ${cards}
            </section>`;
    }).join('');

    const statusOptions = statuses.map((status) =>
        `<option value="${escapeHtml(status.id)}">${escapeHtml(status.name)}</option>`
    ).join('');

    const formDisabled = statuses.length === 0;
    const statusList = statuses.length
        ? statuses.map((status) => `
            <li>
                <span>${escapeHtml(status.name)}</span>
                <span class="entity-actions">
                    <button class="button primary-button secondary-button" type="button"
                        data-rename-status="${escapeHtml(status.id)}"
                        data-status-name="${escapeHtml(status.name)}">編輯</button>
                    <button class="button danger-button secondary-button" type="button"
                        data-delete-status="${escapeHtml(status.id)}">刪除</button>
                </span>
            </li>`).join('')
        : '<li class="empty">尚未建立狀態</li>';
    const tagList = board.tags.length
        ? board.tags.map((tag) => `
            <li>
                <span>${escapeHtml(tag.name)}</span>
                <span class="entity-actions">
                    <button class="button primary-button secondary-button" type="button"
                        data-edit-tag="${escapeHtml(tag.id)}"
                        data-tag-name="${escapeHtml(tag.name)}">編輯</button>
                    <button class="button danger-button secondary-button" type="button"
                        data-delete-tag="${escapeHtml(tag.id)}">刪除</button>
                </span>
            </li>`).join('')
        : '<li class="empty">尚未建立標籤</li>';
    const tagOptions = board.tags.length
        ? board.tags.map((tag) => `
            <div class="tag-option">
                <input type="checkbox" name="tagId" value="${escapeHtml(tag.id)}"
                    aria-label="${escapeHtml(tag.name)}">
                <span>${escapeHtml(tag.name)}</span>
            </div>`).join('')
        : '<span class="empty">目前沒有可選標籤。</span>';

    return /* html */ `
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; }
body {
    margin: 0; padding: 12px 16px 16px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
}
.header {
    display: flex; align-items: center;
    justify-content: space-between; gap: 8px;
    position: fixed; top: 0; left: 0; right: 0; z-index: 20;
    flex-wrap: wrap; margin: 0; padding: 8px 16px;
    background: var(--vscode-editor-background);
    box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, .28));
    transform: translateY(calc(-100% + 8px));
    transition: transform .18s ease-out;
}
.header:hover, .header:focus-within {
    transform: translateY(0);
}
.header-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.icon-button {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; padding: 0; font-size: 20px;
}
.search-icon { font-size: 22px; line-height: 1; }
.board-menu { position: relative; }
.menu-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 38px; height: 36px; padding: 0; font-size: 18px;
    list-style: none;
}
.menu-toggle::-webkit-details-marker { display: none; }
.floating-menu-panel {
    border: 1px solid var(--vscode-focusBorder, #8ab4f8); border-radius: 8px;
    background: var(--vscode-input-background);
    box-shadow: 0 6px 18px var(--vscode-widget-shadow, rgba(0, 0, 0, .28));
}
.board-menu-panel {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 5;
    min-width: 140px; padding: 8px;
}
.menu-group + .menu-group {
    margin-top: 6px; padding-top: 6px;
    border-top: 1px solid var(--vscode-panel-border);
}
.menu-group-label {
    margin: 0; padding: 4px 10px 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px; font-weight: 600;
}
.menu-actions { display: grid; gap: 2px; }
.menu-actions button {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 8px 10px; border-radius: 4px;
    background: transparent; text-align: left;
}
.menu-actions button:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryHoverBackground));
}
.menu-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px;
    font-size: 15px; line-height: 1;
}
.subtitle, .footer {
    color: var(--vscode-descriptionForeground); font-size: 12px;
}
.button {
    padding: 8px 14px; border: none; border-radius: 4px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    cursor: pointer;
    font: inherit;
}
.button:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
}
.primary-button {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
}
.button.primary-button:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
}
.task-menu-option.primary-button {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
}
.task-menu-option.primary-button:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
}
.button.danger-button, .task-menu-option.danger-button {
    color: #fff; background: #c42b1c;
}
.button.danger-button:hover, .task-menu-option.danger-button:hover {
    background: #a61b12;
}
.button.warning-button {
    color: #1f1f1f; background: #ff9800;
}
.button.warning-button:hover { background: #f57c00; }
.button.success-button, .task-menu-option.success-button {
    color: #fff; background: #16825d;
}
.button.success-button:hover, .task-menu-option.success-button:hover {
    background: #116b4c;
}
.button:focus-visible, input:focus-visible, textarea:focus-visible,
select:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
}
.button:disabled { opacity: .5; cursor: not-allowed; }
.secondary-button { padding: 4px 8px; font-size: 11px; }
.menu-actions button { width: 100%; text-align: left; }
.entity-management { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.entity-group { min-width: 0; }
.entity-group h2 { margin: 0 0 8px; font-size: 15px; }
.entity-group ul { margin: 0; padding: 0; list-style: none; }
.entity-group li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.entity-group li > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.entity-actions { display: inline-flex; gap: 4px; }
.tag-picker { position: relative; }
.tag-picker-selected { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.tag-picker-selected:empty { display: none; }
#tagPicker .tag-picker-chip {
    display: inline-flex; align-items: center; gap: 4px;
    flex-wrap: nowrap; max-width: 100%;
    padding: 2px 5px; border: 1px solid orange; border-radius: 10px;
    line-height: 1.2; color: #000; background: transparent;
    font-size: 11px;
}
#tagPicker .tag-picker-chip > span {
    display: block; flex: 0 1 auto; min-width: 0; margin: 0;
    overflow: hidden; font-size: inherit; text-overflow: ellipsis;
    white-space: nowrap;
}
#tagPicker .tag-picker-chip button {
    display: inline-flex; flex: 0 0 14px;
    align-items: center; justify-content: center;
    width: 14px; height: 14px; margin: 0; padding: 0;
    border: 0; color: inherit; line-height: 1;
    background: transparent; cursor: pointer; font: inherit;
}
.tag-picker-options {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 6;
    display: none; gap: 2px; max-height: 180px; overflow-y: auto; padding: 6px;
    border: 1px solid var(--vscode-focusBorder, #8ab4f8); border-radius: 8px;
    background: var(--vscode-input-background);
    box-shadow: 0 6px 18px var(--vscode-widget-shadow, rgba(0, 0, 0, .28));
}
.tag-picker.open .tag-picker-options { display: grid; }
.tag-option { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px; border-radius: 4px; font-size: 12px; cursor: pointer; }
.tag-option[hidden] { display: none; }
.tag-option:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryHoverBackground)); }
.tag-option input[type="checkbox"] { width: auto; margin: 0; }
.tag-picker-no-results { margin: 4px; }
.task-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.task-tag {
    padding: 2px 6px; border: 1px solid orange; border-radius: 10px;
    background: transparent; color: #000; font-size: 10px;
}
.notice { margin-bottom: 10px; padding: 10px 12px; border-radius: 4px; background: var(--vscode-inputValidation-infoBackground); }
.ticket-dialog {
    width: min(600px, calc(100vw - 32px));
    max-height: calc(100vh - 32px); padding: 0;
    overflow-y: auto; border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
}
.ticket-dialog::backdrop { background: rgba(0, 0, 0, .55); }
.search-dialog { width: min(520px, calc(100vw - 32px)); }
.search-results {
    display: grid; gap: 4px; max-height: min(55vh, 420px);
    overflow-y: auto; margin: 0; padding: 0; list-style: none;
}
.search-result {
    display: flex; flex-direction: column; align-items: flex-start;
    width: 100%; padding: 9px 10px; text-align: left;
}
.search-result-title { overflow-wrap: anywhere; font-weight: 600; }
.search-result-status { color: var(--vscode-descriptionForeground); font-size: 11px; }
.form { padding: 16px; margin: 0; }
.management-page[hidden] { display: none; }
.management-page { padding-top: 4px; }
.management-form { display: grid; gap: 10px; margin-bottom: 18px; }
.management-form .field { margin-bottom: 0; }
.dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dialog-header h2 { margin: 0 0 14px; }
.board-path { overflow-wrap: anywhere; }
.field { display: block; margin-bottom: 14px; }
.field span { display: block; margin-bottom: 6px; font-size: 13px; }
input, textarea, select {
    width: 100%; padding: 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px; font: inherit;
}
textarea { min-height: 80px; resize: vertical; }
.form-actions { display: flex; gap: 8px; }
.message { margin-top: 10px; font-size: 12px; }
.operation-message { margin: 0 0 8px; }
.operation-error {
    padding: 10px 12px; border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 4px; color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
}
.board {
    display: grid;
    grid-template-columns: repeat(${statuses.length}, minmax(210px, 1fr));
    gap: 12px; align-items: start; overflow-x: auto;
    min-width: 0; max-width: 100%; padding-bottom: 8px;
}
.column {
    min-width: 210px; padding: 10px; border-radius: 8px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
}
.column-header {
    display: flex; justify-content: space-between;
    gap: 8px; margin-bottom: 10px;
    font-size: 14px; font-weight: 600;
}
.column-title-group { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.column-add-ticket {
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 24px; width: 24px; height: 24px; padding: 0;
    border: 0; border-radius: 4px; color: var(--vscode-descriptionForeground);
    background: transparent; cursor: pointer; font: inherit; font-size: 18px;
    line-height: 1;
}
.column-add-ticket:hover, .column-add-ticket:focus-visible {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground);
}
.column-add-ticket:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
}
.column-header-actions { display: inline-flex; align-items: center; gap: 6px; }
.count, .task-meta {
    color: var(--vscode-descriptionForeground); font-size: 11px;
}
.column-sort { position: relative; font-weight: 400; }
.sort-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 4px;
    color: var(--vscode-descriptionForeground); cursor: pointer;
    list-style: none; font-size: 16px;
}
.sort-toggle::-webkit-details-marker { display: none; }
.sort-toggle:hover, .sort-toggle:focus-visible {
    color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground);
}
.column-sort-panel {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 5;
    min-width: 140px; padding: 8px;
}
.column-sort-panel .menu-actions button[aria-pressed="true"] {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
}
.column-sort-panel .menu-actions button[aria-pressed="true"]::before { content: "✓ "; }
.task {
    position: relative;
    margin-bottom: 8px; padding: 10px;
    border: 1px solid #808080;
    border-radius: 6px; background: var(--vscode-editor-background);
    overflow-wrap: anywhere;
}
.task:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
}
.task.search-focus {
    border: 2px dashed #3794ff;
}
.task.search-focus:focus-visible { outline: none; }
.task-heading { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.task-menu { position: relative; flex: 0 0 auto; z-index: 2; }
.task-menu[open] { z-index: 20; }
.priority-dot {
    display: inline-block; flex: 0 0 16px;
    width: 16px; height: 16px; margin: 0; padding: 0;
    border: 0; border-radius: 50%; cursor: pointer;
}
.priority-0 { background: #9ca3af; }
.priority-1 { background: #1ca950; }
.priority-2 { background: #3b4ef6; }
.priority-3 { background: #ff2d2d; }
.priority-dot:hover { filter: brightness(.85); }
.priority-dot:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.task-menu-toggle {
    position: relative; z-index: 6;
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 24px; border-radius: 4px;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    cursor: pointer; list-style: none; font-weight: 600;
}
.task-menu-toggle::-webkit-details-marker { display: none; }
.task-menu-toggle:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
}
.task-menu-panel {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 5;
    min-width: 0; width: 64px; padding: 6px;
    display: flex; flex-direction: column; gap: 6px;
}
.task-menu-option {
    display: block; width: 100%; padding: 7px 4px; border: 0;
    border-radius: 4px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: transparent; text-align: left; cursor: pointer; font: inherit;
}
.task-menu-option:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryHoverBackground));
}
.task[draggable="true"] { cursor: grab; }
.task.dragging { opacity: .45; }
.column.drag-over { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -4px; }
.task-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; cursor: default; }
.task-description { margin-bottom: 8px; font-size: 12px; white-space: pre-wrap; }
.empty { padding: 12px 4px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.footer { margin-top: 12px; }
@media (max-width: 520px) {
    body { padding: 10px 12px 12px; }
    .header { padding: 8px 12px; }
    .entity-group li { flex-wrap: wrap; align-items: flex-start; }
    .entity-actions { flex-shrink: 0; margin-left: auto; }
    .form-actions { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
    .header { transition: none; }
}
</style>
</head>
<body>
<header class="header">
    <div class="header-actions">
        <details class="board-menu" id="boardMenu">
            <summary class="button menu-toggle" aria-label="管理選單" title="管理選單">☰</summary>
            <div class="board-menu-panel floating-menu-panel">
                <section class="menu-group" aria-labelledby="menuGroupItems">
                    <h2 class="menu-group-label" id="menuGroupItems">項目管理</h2>
                    <div class="menu-actions">
                    <button class="button" type="button" data-open-management="tags">
                        <span class="menu-icon" aria-hidden="true">🏷️</span>標籤
                    </button>
                    <button class="button" type="button" data-open-management="statuses">
                        <span class="menu-icon" aria-hidden="true">≡</span>狀態
                    </button>
                    </div>
                </section>
                <section class="menu-group" aria-labelledby="menuGroupData">
                    <h2 class="menu-group-label" id="menuGroupData">設定</h2>
                    <div class="menu-actions">
                    <button class="button" type="button" data-open-management="boardPath">
                        <span class="menu-icon" aria-hidden="true">📁</span>路徑
                    </button>
                    </div>
                </section>
            </div>
        </details>
        <button class="button icon-button" id="openSearch" type="button"
            aria-label="搜尋任務標題" title="搜尋任務標題">
            <span class="search-icon" aria-hidden="true">&#x1F50E;&#xFE0E;</span>
        </button>
        <button class="button icon-button" id="toggleForm" type="button"
            aria-label="新增任務" title="新增任務" ${formDisabled ? 'disabled' : ''}>＋</button>
    </div>
</header>

${formDisabled ? '<p>目前沒有可用的工作流程狀態，無法新增任務。</p>' : ''}

<dialog id="searchDialog" class="ticket-dialog search-dialog"
    aria-labelledby="searchHeading">
    <div class="form">
        <div class="dialog-header">
            <h2 id="searchHeading">搜尋任務標題</h2>
            <button class="button" id="closeSearch" type="button">Ｘ</button>
        </div>
        <label class="field">
            <span>輸入標題關鍵字</span>
            <input id="searchInput" type="search" autocomplete="off"
                placeholder="搜尋任務標題">
        </label>
        <p id="searchMessage" class="subtitle" role="status" aria-live="polite">
            輸入關鍵字搜尋任務標題。
        </p>
        <ul id="searchResults" class="search-results"></ul>
    </div>
</dialog>

<dialog id="renameStatusDialog" class="ticket-dialog"
    aria-labelledby="renameStatusHeading">
<form id="renameStatusForm" class="form">
    <h2 id="renameStatusHeading">重新命名狀態</h2>
    <label class="field">
        <span>狀態名稱 *</span>
        <input id="renameStatusName" maxlength="100" required>
    </label>
    <div class="form-actions">
        <button class="button primary-button" type="submit">儲存</button>
        <button class="button warning-button" id="cancelRenameStatus" type="button">取消</button>
    </div>
</form>
</dialog>

<dialog id="editTagDialog" class="ticket-dialog" aria-labelledby="editTagHeading">
<form id="editTagForm" class="form">
    <h2 id="editTagHeading">重新命名標籤</h2>
    <label class="field">
        <span>標籤名稱 *</span>
        <input id="editTagName" maxlength="100" required>
    </label>
    <div class="form-actions">
        <button class="button primary-button" type="submit">儲存</button>
        <button class="button warning-button" id="cancelEditTag" type="button">取消</button>
    </div>
</form>
</dialog>

<dialog id="ticketDialog" class="ticket-dialog" aria-labelledby="formHeading">
<form id="ticketForm" class="form">
    <div class="dialog-header">
        <h2 id="formHeading">新增任務</h2>
        <button class="button" id="closeTicketDialog" type="button">Ｘ</button>
    </div>
    <label class="field">
        <span>標題 *</span>
        <input id="title" maxlength="200" required autofocus>
    </label>
    <label class="field">
        <span>描述</span>
        <textarea id="description"></textarea>
    </label>
    <div class="field">
        <span>標籤</span>
        <div class="tag-picker" id="tagPicker">
            <div class="tag-picker-selected" id="selectedTagList"
                aria-label="已選標籤"></div>
            <input id="tagSearch" type="search" placeholder="輸入文字查找標籤"
                autocomplete="off" aria-label="搜尋標籤" aria-controls="tagPickerOptions"
                aria-expanded="false">
            <div class="tag-picker-options" id="tagPickerOptions">${tagOptions}
                <button class="button primary-button secondary-button tag-picker-no-results"
                    id="tagPickerNoResults" type="button" data-open-management="tags"
                    hidden>新增/編輯標籤</button>
            </div>
        </div>
    </div>
    <label class="field">
        <span>狀態 *</span>
        <select id="statusId" required>${statusOptions}</select>
    </label>
    <label class="field">
        <span>優先序</span>
        <select id="priority" required>
            <option value="3">🔴 高</option>
            <option value="2">🔵 中</option>
            <option value="1">🟢 低</option>
            <option value="0" selected>⚪ 無</option>
        </select>
    </label>
    <label class="field">
        <span>到期日</span>
        <input id="dueDate" type="date">
        <small class="subtitle">選填；不設定時會儲存為 null。</small>
    </label>
    <div class="form-actions">
        <button class="button primary-button" type="submit" id="saveButton">儲存任務</button>
        <button class="button warning-button" type="button" id="cancelButton">取消</button>
    </div>
    <div class="message" id="message" role="status"></div>
</form>
</dialog>

<dialog id="managementDialog" class="ticket-dialog" aria-labelledby="managementHeading">
<div class="form">
    <div class="dialog-header">
        <h2 id="managementHeading">管理</h2>
        <button class="button" id="closeManagement" type="button">Ｘ</button>
    </div>
    <section class="management-page" data-management-page="tags" hidden>
        <form id="tagForm" class="management-form">
            <label class="field">
                <span>標籤名稱 *</span>
                <input id="newTagName" maxlength="100" required>
            </label>
            <button class="button primary-button" type="submit">新增標籤</button>
        </form>
        <section class="entity-management" aria-label="共用標籤">
            <div class="entity-group">
                <h2>共用標籤</h2>
                <ul>${tagList}</ul>
            </div>
        </section>
    </section>
    <section class="management-page" data-management-page="statuses" hidden>
        <form id="statusForm" class="management-form">
            <label class="field">
                <span>狀態名稱 *</span>
                <input id="newStatusName" maxlength="100" required>
            </label>
            <button class="button primary-button" type="submit"
                ${board.statuses.length >= PRODUCT_RULES.maxStatuses ? 'disabled' : ''}>新增狀態</button>
        </form>
        <section class="entity-management" aria-label="工作流程狀態">
            <div class="entity-group">
                <h2>工作流程狀態</h2>
                <ul>${statusList}</ul>
            </div>
        </section>
    </section>
    <section class="management-page" data-management-page="boardPath" hidden>
        <p class="subtitle">目前看板檔案</p>
        <p class="board-path">${escapeHtml(boardPath)}</p>
        <button class="button success-button" id="changeBoardLocation" type="button">變更預設 JSON 路徑</button>
    </section>
    <div class="message operation-message management-message" id="managementMessage"
        role="status" aria-live="polite">${notice ? escapeHtml(notice) : ''}</div>
</div>
</dialog>

${notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : ''}
<div class="message operation-message" id="operationMessage"
    role="status" aria-live="polite"></div>
<main class="board">${columns}</main>
<footer class="footer">TuolaFlowVSCode · 共 ${board.tickets.length} 個任務</footer>

<script>
const vscode = acquireVsCodeApi();
const sortModes = ${JSON.stringify(sortModes)};
const form = document.getElementById('ticketForm');
const ticketDialog = document.getElementById('ticketDialog');
const renameStatusDialog = document.getElementById('renameStatusDialog');
const renameStatusForm = document.getElementById('renameStatusForm');
const renameStatusName = document.getElementById('renameStatusName');
const editTagDialog = document.getElementById('editTagDialog');
const editTagForm = document.getElementById('editTagForm');
const editTagName = document.getElementById('editTagName');
const message = document.getElementById('message');
const saveButton = document.getElementById('saveButton');
const formHeading = document.getElementById('formHeading');
const operationMessage = document.getElementById('operationMessage');
const boardMenu = document.getElementById('boardMenu');
const tagPicker = document.getElementById('tagPicker');
const tagSearch = document.getElementById('tagSearch');
const tagPickerOptions = document.getElementById('tagPickerOptions');
const tagPickerNoResults = document.getElementById('tagPickerNoResults');
const selectedTagList = document.getElementById('selectedTagList');
const managementDialog = document.getElementById('managementDialog');
const managementHeading = document.getElementById('managementHeading');
const managementMessage = document.getElementById('managementMessage');
const searchDialog = document.getElementById('searchDialog');
const searchInput = document.getElementById('searchInput');
const searchMessage = document.getElementById('searchMessage');
const searchResults = document.getElementById('searchResults');
let editingTicketId = null;
let renamingStatusId = null;
let editingTagId = null;

function updateSearchResults() {
    const query = searchInput.value.trim().toLocaleLowerCase();
    searchResults.replaceChildren();

    if (!query) {
        searchMessage.textContent = '輸入關鍵字搜尋任務標題。';
        return;
    }

    const matches = [...document.querySelectorAll('.task[data-ticket-id]')]
        .filter((card) =>
            card.querySelector('.task-title').textContent
                .toLocaleLowerCase().includes(query)
        );
    searchMessage.textContent = matches.length
        ? '找到 ' + matches.length + ' 個任務。'
        : '沒有符合的任務。';

    for (const card of matches) {
        const item = document.createElement('li');
        const result = document.createElement('button');
        result.type = 'button';
        result.className = 'button search-result';
        result.dataset.ticketId = card.dataset.ticketId;

        const title = document.createElement('span');
        title.className = 'search-result-title';
        title.textContent = card.querySelector('.task-title').textContent;
        const status = document.createElement('span');
        status.className = 'search-result-status';
        status.textContent = card.closest('.column')
            ?.querySelector('.column-title-group > span')
            ?.textContent?.trim() || '未知狀態';

        result.append(title, status);
        item.append(result);
        searchResults.append(item);
    }
}

function openSearchDialog() {
    if (searchDialog.open) {
        searchInput.focus();
        searchInput.select();
        return;
    }

    searchInput.value = '';
    updateSearchResults();
    searchDialog.showModal();
    searchInput.focus();
}

document.getElementById('openSearch').addEventListener('click', openSearchDialog);
document.getElementById('closeSearch').addEventListener('click', () => {
    searchDialog.close();
});
searchInput.addEventListener('input', updateSearchResults);
searchResults.addEventListener('click', (event) => {
    const result = event.target.closest('button[data-ticket-id]');
    if (!result) return;

    const card = [...document.querySelectorAll('.task[data-ticket-id]')]
        .find((item) => item.dataset.ticketId === result.dataset.ticketId);
    if (!card) {
        searchMessage.textContent = '找不到此任務，請重新搜尋。';
        return;
    }

    searchDialog.close();
    requestAnimationFrame(() => {
        card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        card.classList.add('search-focus');
        card.addEventListener('blur', () => {
            card.classList.remove('search-focus');
        }, { once: true });
        card.focus({ preventScroll: true });
    });
});
document.addEventListener('pointerdown', (event) => {
    const focusedCard = document.querySelector('.task.search-focus');
    if (focusedCard && !focusedCard.contains(event.target)) {
        focusedCard.blur();
    }
});

function updateTagPicker() {
    const query = tagSearch.value.trim().toLocaleLowerCase();
    const options = [...tagPickerOptions.querySelectorAll('.tag-option')];
    let visibleCount = 0;
    for (const option of options) {
        const matches = option.textContent.toLocaleLowerCase().includes(query);
        option.hidden = !matches;
        if (matches) visibleCount += 1;
    }
    tagPickerNoResults.hidden = visibleCount > 0;
    selectedTagList.replaceChildren();
    for (const option of options) {
        const checkbox = option.querySelector('input[name="tagId"]');
        if (!checkbox.checked) continue;

        const chip = document.createElement('span');
        chip.className = 'tag-picker-chip';
        const name = document.createElement('span');
        name.textContent = option.querySelector('span').textContent;
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.dataset.removeTagId = checkbox.value;
        removeButton.setAttribute('aria-label', '移除標籤 ' + name.textContent);
        removeButton.textContent = '×';
        chip.append(name, removeButton);
        selectedTagList.append(chip);
    }
}

function setTagPickerOpen(open) {
    tagPicker.classList.toggle('open', open);
    tagSearch.setAttribute('aria-expanded', String(open));
}

tagSearch.addEventListener('focus', () => {
    setTagPickerOpen(true);
});
tagSearch.addEventListener('input', updateTagPicker);
tagPickerOptions.addEventListener('change', updateTagPicker);
tagPickerOptions.addEventListener('pointerdown', (event) => {
    const option = event.target.closest('.tag-option');
    if (option && !event.target.closest('input[type="checkbox"]')) {
        event.preventDefault();
    }
});
tagPickerOptions.addEventListener('click', (event) => {
    const option = event.target.closest('.tag-option');
    if (
        !option ||
        event.target.closest('input[type="checkbox"]')
    ) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    const checkbox = option.querySelector('input[name="tagId"]');
    if (!checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setTagPickerOpen(true);
});
selectedTagList.addEventListener('click', (event) => {
    const removeButton = event.target.closest('button[data-remove-tag-id]');
    if (!removeButton) return;

    const checkbox = [...tagPickerOptions.querySelectorAll('input[name="tagId"]')]
        .find((item) => item.value === removeButton.dataset.removeTagId);
    if (!checkbox) {
        throw new Error('找不到要移除的標籤選項。');
    }
    checkbox.checked = false;
    updateTagPicker();
});
tagPicker.addEventListener('focusout', () => {
    setTimeout(() => {
        if (!tagPicker.contains(document.activeElement)) {
            setTagPickerOpen(false);
        }
    }, 0);
});
document.addEventListener('click', (event) => {
    if (!tagPicker.contains(event.target)) {
        setTagPickerOpen(false);
    }
});
tagSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        setTagPickerOpen(false);
        tagSearch.blur();
    }
});
form.addEventListener('reset', () => {
    setTimeout(updateTagPicker, 0);
});
updateTagPicker();

boardMenu.addEventListener('click', (event) => {
    if (event.target.closest('button')) {
        boardMenu.open = false;
    }
});

function openManagementPage(page, clearMessage = true) {
    const headings = {
        tags: '管理標籤',
        statuses: '管理狀態',
        boardPath: '預設 JSON 路徑'
    };
    if (!Object.hasOwn(headings, page)) return;
    managementHeading.textContent = headings[page];
    document.querySelectorAll('[data-management-page]').forEach((section) => {
        section.hidden = section.dataset.managementPage !== page;
    });
    if (clearMessage) {
        managementMessage.textContent = '';
        managementMessage.classList.remove('operation-error');
    }
    vscode.setState({ managementPage: page });
    managementDialog.showModal();
}

document.querySelectorAll('[data-open-management]').forEach((button) => {
    button.addEventListener('click', () => {
        openManagementPage(button.dataset.openManagement);
    });
});

document.getElementById('closeManagement').addEventListener('click', () => {
    managementDialog.close();
});
managementDialog.addEventListener('close', () => {
    vscode.setState({});
});

const savedState = vscode.getState();
if (savedState?.managementPage) {
    openManagementPage(savedState.managementPage, false);
}

document.getElementById('tagForm').addEventListener('submit', (event) => {
    event.preventDefault();
    vscode.postMessage({
        type: 'createTag',
        name: document.getElementById('newTagName').value
    });
});

document.getElementById('statusForm').addEventListener('submit', (event) => {
    event.preventDefault();
    vscode.postMessage({
        type: 'createStatus',
        name: document.getElementById('newStatusName').value
    });
});

document.getElementById('changeBoardLocation').addEventListener('click', () => {
    vscode.postMessage({ type: 'changeBoardLocation' });
});

renameStatusForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!renamingStatusId) {
        throw new Error('找不到要重新命名的狀態，請重新整理看板。');
    }
    vscode.postMessage({
        type: 'renameStatus',
        statusId: renamingStatusId,
        name: renameStatusName.value
    });
    renameStatusDialog.close();
});

document.getElementById('cancelRenameStatus').addEventListener('click', () => {
    renameStatusDialog.close();
});

renameStatusDialog.addEventListener('close', () => {
    renamingStatusId = null;
    renameStatusForm.reset();
});

editTagForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!editingTagId) {
        throw new Error('找不到要編輯的標籤，請重新整理看板。');
    }
    vscode.postMessage({
        type: 'updateTag',
        tagId: editingTagId,
        name: editTagName.value
    });
    editTagDialog.close();
});

document.getElementById('cancelEditTag').addEventListener('click', () => {
    editTagDialog.close();
});

editTagDialog.addEventListener('close', () => {
    editingTagId = null;
    editTagForm.reset();
});

function openNewTicketForm(statusId) {
    editingTicketId = null;
    form.reset();
    document.getElementById('priority').value = '0';
    if (statusId) {
        const statusSelect = document.getElementById('statusId');
        if ([...statusSelect.options].some((option) => option.value === statusId)) {
            statusSelect.value = statusId;
        }
    }
    formHeading.textContent = '新增任務';
    saveButton.textContent = '儲存任務';
    saveButton.disabled = false;
    message.textContent = '';
    operationMessage.textContent = '';
    operationMessage.classList.remove('operation-error');
    ticketDialog.showModal();
    document.getElementById('title').focus();
}

document.getElementById('toggleForm').addEventListener('click', () => {
    openNewTicketForm();
});

document.getElementById('cancelButton').addEventListener('click', () => {
    ticketDialog.close();
});
document.getElementById('closeTicketDialog').addEventListener('click', () => {
    ticketDialog.close();
});

ticketDialog.addEventListener('close', () => {
    form.reset();
    editingTicketId = null;
    formHeading.textContent = '新增任務';
    saveButton.textContent = '儲存任務';
    saveButton.disabled = false;
    message.textContent = '';
});

document.addEventListener('click', (event) => {
    document.querySelectorAll('details[open]').forEach((menu) => {
        if (!menu.contains(event.target)) {
            menu.open = false;
        }
    });

    const button = event.target.closest('button');
    const card = event.target.closest('.task[data-ticket-id]');

    if (
        card &&
        !button &&
        !event.target.closest('.task-heading') &&
        !event.target.closest('summary, a, input, select, textarea')
    ) {
        openTicketEditor(card);
        return;
    }
    if (!button) return;

    if (button.dataset.priorityTicketId) {
        const nextPriority = (Number(button.dataset.priority) + 1) % 4;
        vscode.postMessage({
            type: 'updateTicketPriority',
            ticketId: button.dataset.priorityTicketId,
            priority: nextPriority
        });
        return;
    }

    if (button.dataset.createTicketStatus) {
        openNewTicketForm(button.dataset.createTicketStatus);
        return;
    }

    if (button.dataset.sortStatus && button.dataset.sortMode) {
        vscode.postMessage({
            type: 'sortTickets',
            statusId: button.dataset.sortStatus,
            mode: button.dataset.sortMode
        });
        button.closest('.column-sort').open = false;
        return;
    }

    if (button.dataset.copyTicket) {
        vscode.postMessage({
            type: 'copyTicket',
            ticketId: button.dataset.copyTicket
        });
        button.closest('.task-menu').open = false;
        return;
    }

    if (button.dataset.editTicket) {
        openTicketEditor(button.closest('.task'));
        button.closest('.task-menu').open = false;
        return;
    }

    if (button.dataset.renameStatus) {
        renamingStatusId = button.dataset.renameStatus;
        renameStatusName.value = button.dataset.statusName;
        renameStatusDialog.showModal();
        renameStatusName.focus();
        return;
    }

    if (button.dataset.deleteStatus) {
        vscode.postMessage({
            type: 'deleteStatus',
            statusId: button.dataset.deleteStatus
        });
        return;
    }

    if (button.dataset.editTag) {
        editingTagId = button.dataset.editTag;
        editTagName.value = button.dataset.tagName;
        editTagDialog.showModal();
        editTagName.focus();
        return;
    }

    if (button.dataset.deleteTag) {
        vscode.postMessage({
            type: 'deleteTag',
            tagId: button.dataset.deleteTag
        });
        return;
    }

    if (
        button.dataset.deleteTicket
    ) {
        button.closest('.task-menu').open = false;
        vscode.postMessage({
            type: 'deleteTicket',
            ticketId: button.dataset.deleteTicket
        });
    }
});

document.addEventListener('keydown', (event) => {
    const card = event.target.closest('.task[data-ticket-id]');
    if (
        !card ||
        event.target !== card ||
        (event.key !== 'Enter' && event.key !== ' ')
    ) {
        return;
    }

    event.preventDefault();
    openTicketEditor(card);
});

function openTicketEditor(card) {
    editingTicketId = card.dataset.ticketId;
    document.getElementById('title').value = card.dataset.title;
    document.getElementById('description').value = card.dataset.description;
    const selectedTagIds = JSON.parse(card.dataset.tagIds);
    document.querySelectorAll('input[name="tagId"]').forEach((checkbox) => {
        checkbox.checked = selectedTagIds.includes(checkbox.value);
    });
    tagSearch.value = '';
    updateTagPicker();
    document.getElementById('statusId').value = card.dataset.statusId;
    document.getElementById('priority').value = card.dataset.priority;
    document.getElementById('dueDate').value = card.dataset.dueDate;
    formHeading.textContent = '編輯任務';
    saveButton.textContent = '儲存變更';
    saveButton.disabled = false;
    message.textContent = '';
    operationMessage.textContent = '';
    operationMessage.classList.remove('operation-error');
    ticketDialog.showModal();
}

function closeOpenMenus() {
    document.querySelectorAll('details[open]').forEach((menu) => {
        menu.open = false;
    });
}

document.addEventListener('focusout', (event) => {
    const menu = event.target.closest('details[open]');
    if (!menu) return;

    setTimeout(() => {
        if (!menu.contains(document.activeElement)) {
            menu.open = false;
        }
    }, 0);
});

window.addEventListener('blur', closeOpenMenus);

const boardElement = document.querySelector('.board');
let draggedTicketId = null;
let pointerDownOnTaskHeading = false;

boardElement.addEventListener('pointerdown', (event) => {
    pointerDownOnTaskHeading = Boolean(event.target.closest('.task-heading'));
});
document.addEventListener('pointerup', () => {
    pointerDownOnTaskHeading = false;
});
document.addEventListener('pointercancel', () => {
    pointerDownOnTaskHeading = false;
});

boardElement.addEventListener('dragstart', (event) => {
    if (pointerDownOnTaskHeading) {
        pointerDownOnTaskHeading = false;
        event.preventDefault();
        return;
    }

    const card = event.target.closest('.task[draggable="true"]');
    if (!card) {
        event.preventDefault();
        return;
    }

    draggedTicketId = card.dataset.ticketId;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedTicketId);
});

boardElement.addEventListener('dragend', (event) => {
    event.target.closest('.task')?.classList.remove('dragging');
    boardElement.querySelectorAll('.drag-over').forEach((column) => {
        column.classList.remove('drag-over');
    });
    draggedTicketId = null;
});

boardElement.addEventListener('dragover', (event) => {
    if (!draggedTicketId) return;
    const column = event.target.closest('.column[data-status-id]');
    if (!column || column.dataset.sortMode !== 'manual') return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    column.classList.add('drag-over');
});

boardElement.addEventListener('dragleave', (event) => {
    const column = event.target.closest('.column');
    if (column && !column.contains(event.relatedTarget)) {
        column.classList.remove('drag-over');
    }
});

boardElement.addEventListener('drop', (event) => {
    if (!draggedTicketId) return;
    const column = event.target.closest('.column[data-status-id]');
    if (!column || column.dataset.sortMode !== 'manual') return;

    event.preventDefault();
    column.classList.remove('drag-over');
    const statusId = column.dataset.statusId;
    const cards = [...column.querySelectorAll('.task[data-ticket-id]')]
        .filter((card) => card.dataset.ticketId !== draggedTicketId);
    const targetCard = event.target.closest('.task[data-ticket-id]');
    if (targetCard?.dataset.ticketId === draggedTicketId) return;
    let index = cards.length;

    if (targetCard && targetCard.dataset.ticketId !== draggedTicketId) {
        const targetIndex = cards.indexOf(targetCard);
        const bounds = targetCard.getBoundingClientRect();
        index = targetIndex + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
    }

    vscode.postMessage({
        type: 'reorderTicket',
        ticketId: draggedTicketId,
        statusId,
        index
    });
});

form.addEventListener('submit', (event) => {
    event.preventDefault();
    message.textContent = '正在儲存...';
    saveButton.disabled = true;

    vscode.postMessage({
        type: editingTicketId ? 'updateTicket' : 'createTicket',
        ticketId: editingTicketId,
        title: document.getElementById('title').value,
        description: document.getElementById('description').value,
        tagIds: [...document.querySelectorAll('input[name="tagId"]:checked')]
            .map((checkbox) => checkbox.value),
        statusId: document.getElementById('statusId').value,
        priority: Number(document.getElementById('priority').value),
        dueDate: document.getElementById('dueDate').value || null
    });
});

window.addEventListener('message', (event) => {
    const result = event.data;

    if (result.type === 'openSearchDialog') {
        openSearchDialog();
        return;
    }

    if (result.type !== 'ticketOperationResult') return;

    message.textContent = result.message;
    operationMessage.textContent = result.message;
    managementMessage.textContent = result.message;
    operationMessage.classList.toggle('operation-error', !result.success);
    managementMessage.classList.toggle('operation-error', !result.success);
    operationMessage.setAttribute('role', result.success ? 'status' : 'alert');
    operationMessage.setAttribute('aria-live', result.success ? 'polite' : 'assertive');
    saveButton.disabled = false;
});
</script>
</body>
</html>`;
}

function getErrorHtml(message: string): string {
    return /* html */ `
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { padding: 24px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
.error {
    padding: 16px; border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 6px; color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    white-space: pre-wrap; overflow-wrap: anywhere;
}
</style>
</head>
<body>
<h2>無法載入任務看板</h2>
<div class="error" role="alert">${escapeHtml(message)}</div>
<p>請確認目前設定的看板位置正確，且檔案可讀取。</p>
<p>若檔案有 JSON 格式錯誤或 Git 合併衝突，請先複製備份，再修正 JSON 或衝突標記後重新開啟。看板不會自動重設、改選其他位置或覆蓋無法載入的檔案。</p>
</body>
</html>`;
}

export function deactivate(): void {
    // 目前沒有額外資源需要清理。
}
