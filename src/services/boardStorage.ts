
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  PRODUCT_RULES,
  type Board
} from '../models/board';

const SUPPORTED_SCHEMA_VERSION = PRODUCT_RULES.schemaVersion;

export function validateBoard(board: unknown): asserts board is Board {
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    throw new Error('看板資料格式錯誤：最外層必須是物件。');
  }

  const data = board as Record<string, unknown>;
  const requiredArrays = [
    'tags',
    'statuses',
    'tickets',
  ];

  if (data.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `不支援的資料版本：${String(data.schemaVersion)}。`
    );
  }

  for (const key of requiredArrays) {
    if (!Array.isArray(data[key])) {
      throw new Error(`看板資料格式錯誤：${key} 必須是陣列。`);
    }
  }

  const tags = data.tags as Record<string, unknown>[];
  const statuses = data.statuses as Record<string, unknown>[];
  const tickets = data.tickets as Record<string, unknown>[];

  if (
    statuses.length < PRODUCT_RULES.minStatuses ||
    statuses.length > PRODUCT_RULES.maxStatuses
  ) {
    throw new Error(
      `狀態數量必須介於 ${PRODUCT_RULES.minStatuses} 到 ${PRODUCT_RULES.maxStatuses} 個。`
    );
  }

  const allIds: string[] = [];

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function checkId(item: Record<string, unknown>): string {
    if (typeof item.id !== 'string' || !uuidPattern.test(item.id)) {
      throw new Error('資料包含無效的 UUID。');
    }

    allIds.push(item.id.toLowerCase());
    return item.id;
  }

  function checkName(
    item: Record<string, unknown>,
    field: string
  ): string {
    const value = item[field];

    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`資料欄位 ${field} 不可為空。`);
    }

    return value.trim();
  }

  function isValidDateOnly(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const [year, month, day] = value.split('-').map(Number);

    const date = new Date(
      Date.UTC(year, month - 1, day)
    );

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  const statusIds = new Set<string>();

  for (const item of tags) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('標籤資料格式錯誤。');
    }

    const id = checkId(item);
    const name = checkName(item, 'name');
    if (Object.prototype.hasOwnProperty.call(item, 'category')) {
      throw new Error(`標籤不可包含分類欄位：${name}`);
    }
    const tagNameKey = name.toLowerCase();
    if (tagNames.has(tagNameKey)) {
      throw new Error(`標籤名稱不可重複：${name}`);
    }
    tagNames.add(tagNameKey);

    tagIds.add(id);
  }

  const statusNames = new Set<string>();
  const statusOrders = new Set<number>();

  for (const item of statuses) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('狀態資料格式錯誤。');
    }

    const id = checkId(item);
    const name = checkName(item, 'name');

    if (
      !Number.isInteger(item.order) ||
      (item.order as number) < 0
    ) {
      throw new Error(`狀態排序值無效：${name}`);
    }

    const normalizedName = name.toLowerCase();

    if (statusNames.has(normalizedName)) {
      throw new Error(`狀態名稱重複：${name}`);
    }

    if (statusOrders.has(item.order as number)) {
      throw new Error(`狀態排序值重複：${item.order}`);
    }

    statusNames.add(normalizedName);
    statusOrders.add(item.order as number);
    statusIds.add(id);
  }

  const ticketOrders = new Set<string>();

  for (const item of tickets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('任務資料格式錯誤。');
    }

    checkId(item);
    checkName(item, 'title');

    if (typeof item.description !== 'string') {
      throw new Error('任務 description 必須是字串。');
    }

    if (
      !Array.isArray(item.tagIds) ||
      item.tagIds.some((tagId) =>
        typeof tagId !== 'string' || !tagIds.has(tagId)
      ) ||
      new Set(item.tagIds).size !== item.tagIds.length
    ) {
      throw new Error('任務引用了無效或重複的標籤。');
    }

    if (
      typeof item.statusId !== 'string' ||
      !statusIds.has(item.statusId)
    ) {
      throw new Error('任務引用了不存在的狀態。');
    }

    if (
      typeof item.order !== 'number' ||
      !Number.isFinite(item.order)
    ) {
      throw new Error('任務排序值必須是有限數字。');
    }

    const orderKey = `${item.statusId}:${item.order}`;

    if (ticketOrders.has(orderKey)) {
      throw new Error(
        '同一狀態中不可有重複的任務排序值。'
      );
    }

    ticketOrders.add(orderKey);

    for (const field of ['createdAt', 'updatedAt']) {
      const value = item[field];

      if (
        typeof value !== 'string' ||
        !Number.isFinite(Date.parse(value)) ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)
      ) {
        throw new Error(
          `任務 ${field} 必須是有效的 UTC ISO 時間。`
        );
      }
    }

    if (
      Date.parse(item.updatedAt as string) <
      Date.parse(item.createdAt as string)
    ) {
      throw new Error(
        '任務更新時間不可早於建立時間。'
      );
    }

    // dueDate 必須存在，但可以是 null。
    if (!Object.prototype.hasOwnProperty.call(item, 'dueDate')) {
      throw new Error('任務缺少必要欄位 dueDate。');
    }

    if (item.dueDate !== null) {
      if (
        typeof item.dueDate !== 'string' ||
        !isValidDateOnly(item.dueDate)
      ) {
        throw new Error(
          '任務到期日必須是有效的 YYYY-MM-DD 日期或 null。'
        );
      }
    }

    if (
      !Number.isInteger(item.priority) ||
      (item.priority as number) < 0 ||
      (item.priority as number) > 3
    ) {
      throw new Error('任務優先級必須是 0 到 3 的整數。');
    }
  }

  if (new Set(allIds).size !== allIds.length) {
    throw new Error(
      '標籤、狀態或任務之間存在重複 ID。'
    );
  }
}

async function writeBoardAtomically(filePath: string, board: Board): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.tmp`
  );

  try {
    await fs.writeFile(
      tempPath,
      JSON.stringify(board, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx' }
    );
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(
      `儲存看板失敗，請確認檔案權限及 Git 工作目錄狀態。${String(error)}`
    );
  }
}

export async function loadBoard(filePath: string): Promise<Board> {
  let content: string;

  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      throw new Error(
        `找不到看板資料檔案：${filePath}。不會自動建立空白檔案。`
      );
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `board.json 格式錯誤，無法解析 JSON。原始檔案未被修改：${filePath}`
    );
  }

  if (
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).schemaVersion === 3
  ) {
    const legacyBoard = parsed as Record<string, unknown>;
    const migratedBoard = {
      ...legacyBoard,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      tickets: Array.isArray(legacyBoard.tickets)
        ? legacyBoard.tickets.map((ticket) => {
          if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
            return ticket;
          }
          if (Object.prototype.hasOwnProperty.call(ticket, 'priority')) {
            return ticket;
          }
          return { ...ticket, priority: 0 };
        })
        : legacyBoard.tickets
    };
    validateBoard(migratedBoard);
    await writeBoardAtomically(filePath, migratedBoard);
    return migratedBoard;
  }

  validateBoard(parsed);
  return parsed;
}

export async function createBoardFile(
  filePath: string,
  board: Board
): Promise<void> {
  validateBoard(board);

  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fileHandle = await fs.open(filePath, 'wx');
    await fileHandle.writeFile(
      JSON.stringify(board, null, 2) + '\n',
      { encoding: 'utf8' }
    );
    await fileHandle.close();
    fileHandle = undefined;
  } catch (error) {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw new Error(
        `建立初始看板失敗，請確認資料夾寫入權限。${String(error)}`
      );
    }

    // If another VS Code window created the file first, preserve and load it.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(
        `建立初始看板失敗，請確認資料夾寫入權限。${String(error)}`
      );
    }
    throw error;
  }
}

export async function saveBoard(
  filePath: string,
  board: Board
): Promise<void> {
  validateBoard(board);

  // 儲存前先確認現有檔案可正常讀取，避免覆蓋損壞的資料。
  await loadBoard(filePath);

  await writeBoardAtomically(filePath, board);
}
