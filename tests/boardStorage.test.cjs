const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadBoard, saveBoard, validateBoard } = require('../out/services/boardStorage.js');
const {
    createTicketOnBoard,
    deleteTicketFromBoard,
    reorderTicketOnBoard,
    updateTicketOnBoard
} = require('../out/services/ticketOperations.js');
const { renderTicketCard } = require('../out/services/ticketCardRenderer.js');
const {
    isTicketSortMode,
    sortTickets
} = require('../out/services/ticketSorting.js');
const {
    addStatusToBoard,
    deleteStatusFromBoard,
    isStatusDirection,
    moveStatusOnBoard,
    renameStatusOnBoard
} = require('../out/services/statusOperations.js');
const {
    addTagToBoard,
    deleteTagFromBoard,
    updateTagOnBoard
} = require('../out/services/entityOperations.js');

const tagId = '10000000-0000-4000-8000-000000000001';
const firstStatusId = '20000000-0000-4000-8000-000000000001';
const ticketId = '30000000-0000-4000-8000-000000000001';

function createBoard(statusCount = 2) {
    return {
        schemaVersion: 4,
        tags: [{ id: tagId, name: 'SYS · System' }],
        statuses: Array.from({ length: statusCount }, (_, index) => ({
            id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            name: `Status ${index + 1}`,
            order: index
        })),
        tickets: [{
            id: ticketId,
            title: 'Example',
            description: '',
            tagIds: [tagId],
            statusId: firstStatusId,
            order: 0,
            priority: 0,
            createdAt: '2026-10-20T02:46:23.466Z',
            updatedAt: '2026-10-20T02:46:23.466Z',
            dueDate: null
        }]
    };
}

test('validates the minimum and maximum status-count boundaries', () => {
    assert.throws(() => validateBoard(createBoard(1)));
    assert.doesNotThrow(() => validateBoard(createBoard(2)));
    assert.doesNotThrow(() => validateBoard(createBoard(8)));
    assert.throws(() => validateBoard(createBoard(9)));
});

test('requires dueDate and accepts null or a valid date-only value', () => {
    assert.doesNotThrow(() => validateBoard(createBoard()));

    const datedBoard = createBoard();
    datedBoard.tickets[0].dueDate = '2024-02-29';
    assert.doesNotThrow(() => validateBoard(datedBoard));
});

test('rejects missing, malformed, and impossible due dates', () => {
    const missingDate = createBoard();
    delete missingDate.tickets[0].dueDate;
    assert.throws(() => validateBoard(missingDate));

    for (const dueDate of ['', '2024-2-09', '2023-02-29', '2024-04-31']) {
        const invalidDate = createBoard();
        invalidDate.tickets[0].dueDate = dueDate;
        assert.throws(() => validateBoard(invalidDate), `expected rejection for ${dueDate}`);
    }
});

test('rejects broken references and duplicate identifiers', () => {
    const brokenReference = createBoard();
    brokenReference.tickets[0].tagIds = ['40000000-0000-4000-8000-000000000001'];
    assert.throws(() => validateBoard(brokenReference));

    const duplicateTagReference = createBoard();
    duplicateTagReference.tickets[0].tagIds = [tagId, tagId];
    assert.throws(() => validateBoard(duplicateTagReference));

    const missingTagIds = createBoard();
    delete missingTagIds.tickets[0].tagIds;
    assert.throws(() => validateBoard(missingTagIds));

    const duplicateId = createBoard();
    duplicateId.statuses[0].id = tagId;
    assert.throws(() => validateBoard(duplicateId));
});

test('rejects unsupported schema versions and missing required collections', () => {
    const unsupportedVersion = createBoard();
    unsupportedVersion.schemaVersion = 2;
    assert.throws(() => validateBoard(unsupportedVersion));

    const missingTickets = createBoard();
    delete missingTickets.tickets;
    assert.throws(() => validateBoard(missingTickets));
});

test('rejects duplicate tag names and category fields', () => {
    const duplicateTag = createBoard();
    duplicateTag.tags.push({
        id: '10000000-0000-4000-8000-000000000002',
        name: 'sys · SYSTEM'
    });
    assert.throws(() => validateBoard(duplicateTag));

    const categorizedTag = createBoard();
    categorizedTag.tags[0].category = 'system';
    assert.throws(() => validateBoard(categorizedTag), /不可包含分類欄位/);
});

test('rejects duplicate status names or orders', () => {
    const duplicateStatusName = createBoard();
    duplicateStatusName.statuses[1].name = duplicateStatusName.statuses[0].name;
    assert.throws(() => validateBoard(duplicateStatusName));

    const duplicateStatusOrder = createBoard();
    duplicateStatusOrder.statuses[1].order = duplicateStatusOrder.statuses[0].order;
    assert.throws(() => validateBoard(duplicateStatusOrder));
});

test('rejects duplicate ticket order within a status and invalid timestamp relationships', () => {
    const duplicateTicketOrder = createBoard();
    duplicateTicketOrder.tickets.push({
        ...duplicateTicketOrder.tickets[0],
        id: '30000000-0000-4000-8000-000000000002',
        title: 'Second ticket'
    });
    assert.throws(() => validateBoard(duplicateTicketOrder));

    const invalidTimestamp = createBoard();
    invalidTimestamp.tickets[0].createdAt = 'not-a-timestamp';
    assert.throws(() => validateBoard(invalidTimestamp));

    const updatedBeforeCreated = createBoard();
    updatedBeforeCreated.tickets[0].updatedAt = '2026-10-19T02:46:23.466Z';
    assert.throws(() => validateBoard(updatedBeforeCreated));
});

test('creates a ticket with a stable UUID and valid initial fields', () => {
    const board = createBoard();
    const created = createTicketOnBoard(board, {
        title: '  New ticket  ',
        description: 'Details',
        tagIds: [],
        statusId: firstStatusId,
        dueDate: '2024-02-29'
    });
    const ticket = created.tickets[1];

    assert.equal(board.tickets.length, 1);
    assert.match(ticket.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(ticket.title, 'New ticket');
    assert.deepEqual(ticket.tagIds, []);
    assert.equal(ticket.order, 1);
    assert.equal(ticket.dueDate, '2024-02-29');
    assert.equal(ticket.createdAt, ticket.updatedAt);
    assert.doesNotThrow(() => validateBoard(created));
});

test('updates a ticket without changing its ID or creation time', () => {
    const board = createBoard();
    const addedTag = addTagToBoard(board, { name: 'Urgent' });
    const secondTag = addedTag.tags[1];

    const updated = updateTicketOnBoard(addedTag, ticketId, {
        title: 'Updated title',
        description: 'Updated description',
        tagIds: [tagId, secondTag.id],
        statusId: firstStatusId,
        dueDate: '2024-02-29'
    });

    assert.equal(updated.tickets[0].id, ticketId);
    assert.equal(updated.tickets[0].createdAt, addedTag.tickets[0].createdAt);
    assert.ok(Date.parse(updated.tickets[0].updatedAt) >= Date.parse(updated.tickets[0].createdAt));
    assert.equal(updated.tickets[0].title, 'Updated title');
    assert.deepEqual(updated.tickets[0].tagIds, [tagId, secondTag.id]);
    assert.equal(updated.tickets[0].dueDate, '2024-02-29');
    assert.doesNotThrow(() => validateBoard(updated));
});

test('moving a ticket assigns the next destination order and invalid edits are rejected', () => {
    const board = createBoard();
    board.tickets.push({
        ...board.tickets[0],
        id: '30000000-0000-4000-8000-000000000002',
        title: 'Destination ticket',
        statusId: '20000000-0000-4000-8000-000000000002',
        order: 0
    });

    const moved = updateTicketOnBoard(board, ticketId, {
        title: 'Moved ticket',
        description: '',
        tagIds: [tagId],
        statusId: '20000000-0000-4000-8000-000000000002',
        dueDate: null
    });

    assert.equal(moved.tickets[0].order, 1);
    assert.doesNotThrow(() => validateBoard(moved));
    assert.throws(() => updateTicketOnBoard(board, ticketId, {
        title: 'Invalid edit',
        description: '',
        tagIds: ['40000000-0000-4000-8000-000000000001'],
        statusId: firstStatusId,
        dueDate: null
    }));
});

test('reorders tickets within a status and updates only affected timestamps', () => {
    const board = createBoard();
    board.tickets.push(
        {
            ...board.tickets[0],
            id: '30000000-0000-4000-8000-000000000002',
            title: 'Second ticket',
            order: 1
        },
        {
            ...board.tickets[0],
            id: '30000000-0000-4000-8000-000000000003',
            title: 'Third ticket',
            order: 2
        },
        {
            ...board.tickets[0],
            id: '30000000-0000-4000-8000-000000000004',
            title: 'Fourth ticket',
            order: 3
        }
    );
    const unchangedTimestamp = board.tickets[3].updatedAt;
    const reordered = reorderTicketOnBoard(board, ticketId, firstStatusId, 2);

    assert.deepEqual(
        reordered.tickets
            .filter((ticket) => ticket.statusId === firstStatusId)
            .sort((left, right) => left.order - right.order)
            .map((ticket) => ticket.id),
        [
            '30000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000003',
            ticketId,
            '30000000-0000-4000-8000-000000000004'
        ]
    );
    assert.ok(Date.parse(reordered.tickets[0].updatedAt) >= Date.parse(board.tickets[0].updatedAt));
    assert.equal(reordered.tickets[3].updatedAt, unchangedTimestamp);
    assert.deepEqual(board.tickets.map((ticket) => ticket.order), [0, 1, 2, 3]);
    assert.doesNotThrow(() => validateBoard(reordered));
});

test('moves tickets across statuses and rejects invalid reorder requests', () => {
    const board = createBoard();
    board.tickets.push({
        ...board.tickets[0],
        id: '30000000-0000-4000-8000-000000000002',
        title: 'Destination ticket',
        statusId: '20000000-0000-4000-8000-000000000002',
        order: 0
    });
    const moved = reorderTicketOnBoard(
        board,
        ticketId,
        '20000000-0000-4000-8000-000000000002',
        0
    );

    assert.equal(moved.tickets[0].statusId, '20000000-0000-4000-8000-000000000002');
    assert.equal(moved.tickets[0].order, 0);
    assert.equal(moved.tickets[1].order, 1);
    assert.ok(Date.parse(moved.tickets[0].updatedAt) >= Date.parse(board.tickets[0].updatedAt));
    assert.doesNotThrow(() => validateBoard(moved));
    assert.throws(() => reorderTicketOnBoard(board, 'missing', firstStatusId, 0));
    assert.throws(() => reorderTicketOnBoard(board, ticketId, 'missing', 0));
    assert.throws(() => reorderTicketOnBoard(board, ticketId, firstStatusId, 3));
});

test('deletes only the requested ticket and rejects unknown ticket IDs', () => {
    const board = createBoard();
    board.tickets.push({
        ...board.tickets[0],
        id: '30000000-0000-4000-8000-000000000002',
        title: 'Keep this ticket',
        order: 1
    });

    const deleted = deleteTicketFromBoard(board, ticketId);

    assert.equal(board.tickets.length, 2);
    assert.deepEqual(deleted.tickets.map((ticket) => ticket.id), [
        '30000000-0000-4000-8000-000000000002'
    ]);
    assert.throws(() => deleteTicketFromBoard(board, '40000000-0000-4000-8000-000000000001'));
});

test('renders due dates and tags, escaping ticket and tag content', () => {
    const ticket = createBoard().tickets[0];
    ticket.title = '<script>alert("x")</script>';
    ticket.description = 'Description & details';

    const withoutDueDate = renderTicketCard(ticket, []);
    assert.doesNotMatch(withoutDueDate, /到期日：/);
    assert.match(withoutDueDate, /&lt;script&gt;/);
    assert.match(withoutDueDate, /Description &amp; details/);
    assert.match(withoutDueDate, /data-due-date=""/);
    assert.match(withoutDueDate, /draggable="false"/);

    ticket.dueDate = '2026-10-20';
    const withDueDate = renderTicketCard(ticket, [
        { name: '<unsafe & label>' }
    ]);
    assert.match(withDueDate, /到期日：2026-10-20/);
    assert.match(withDueDate, /&lt;unsafe &amp; label&gt;/);
    assert.doesNotMatch(withDueDate, /task-tag-category/);
    assert.match(withDueDate, /data-tag-ids="\[&quot;10000000-0000-4000-8000-000000000001&quot;\]"/);
    assert.match(withDueDate, /class="task-menu-toggle"[\s\S]*?>⋯/);
    assert.match(withDueDate, /data-copy-ticket="30000000-0000-4000-8000-000000000001"/);
    assert.doesNotMatch(withDueDate, /class="task-actions"/);

    const draggableCard = renderTicketCard(ticket, [], true);
    assert.match(draggableCard, /draggable="true"/);
    assert.doesNotMatch(draggableCard, /data-move-ticket=|>上移<|>下移</);

    const sortedCard = renderTicketCard(ticket, []);
    assert.doesNotMatch(sortedCard, /data-move-ticket=|>上移<|>下移</);
    assert.match(sortedCard, /aria-label="編輯「&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;」"/);
    assert.match(sortedCard, /aria-label="刪除「&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;」"/);
});

test('sorts tickets for display without changing their persisted manual order', () => {
    const tickets = createBoard().tickets;
    tickets.push(
        {
            ...tickets[0],
            id: '30000000-0000-4000-8000-000000000002',
            title: 'Alpha',
            order: 1,
            dueDate: '2026-10-22'
        },
        {
            ...tickets[0],
            id: '30000000-0000-4000-8000-000000000003',
            title: 'Bravo',
            order: 2,
            dueDate: '2026-10-19'
        }
    );
    const originalOrder = tickets.map((ticket) => ticket.id);

    assert.deepEqual(
        sortTickets(tickets, 'manual').map((ticket) => ticket.id),
        originalOrder
    );
    assert.deepEqual(
        sortTickets(tickets, 'title').map((ticket) => ticket.title),
        ['Alpha', 'Bravo', 'Example']
    );
    assert.deepEqual(
        sortTickets(tickets, 'dueDate').map((ticket) => ticket.title),
        ['Bravo', 'Alpha', 'Example']
    );
    assert.deepEqual(tickets.map((ticket) => ticket.id), originalOrder);
    assert.deepEqual(tickets.map((ticket) => ticket.order), [0, 1, 2]);
    assert.equal(isTicketSortMode('manual'), true);
    assert.equal(isTicketSortMode('title'), true);
    assert.equal(isTicketSortMode('dueDate'), true);
    assert.equal(isTicketSortMode('createdAt'), false);
});

test('creates and renames statuses with unique names and stable IDs', () => {
    const board = createBoard();
    const added = addStatusToBoard(board, '  Review  ');
    const created = added.statuses.find((status) => status.name === 'Review');

    assert.ok(created);
    assert.equal(created.order, 2);
    assert.equal(board.statuses.length, 2);
    assert.throws(() => addStatusToBoard(added, ' review '));
    assert.throws(() => addStatusToBoard(createBoard(8), 'Extra'));

    const renamed = renameStatusOnBoard(added, created.id, 'Quality Check');
    assert.equal(renamed.statuses.find((status) => status.id === created.id).name, 'Quality Check');
    assert.equal(renamed.statuses.find((status) => status.id === created.id).id, created.id);
    assert.throws(() => renameStatusOnBoard(renamed, created.id, 'Status 1'));
    assert.throws(() => renameStatusOnBoard(renamed, created.id, '  '));
    assert.doesNotThrow(() => validateBoard(renamed));
});

test('reorders statuses and validates movement direction and boundaries', () => {
    const board = createBoard(3);
    const originalIds = board.statuses.map((status) => status.id);
    const movedUp = moveStatusOnBoard(board, originalIds[1], 'up');

    assert.deepEqual(
        movedUp.statuses.sort((a, b) => a.order - b.order).map((status) => status.id),
        [originalIds[1], originalIds[0], originalIds[2]]
    );
    assert.deepEqual(
        board.statuses.map((status) => status.id),
        originalIds
    );
    assert.throws(() => moveStatusOnBoard(board, originalIds[0], 'up'));
    assert.throws(() => moveStatusOnBoard(board, originalIds[2], 'down'));
    assert.throws(() => moveStatusOnBoard(board, originalIds[0], 'sideways'));
    assert.equal(isStatusDirection('up'), true);
    assert.equal(isStatusDirection('down'), true);
    assert.equal(isStatusDirection('sideways'), false);
    assert.doesNotThrow(() => validateBoard(movedUp));
});

test('allows deleting only empty statuses and prevents deleting below the minimum count', () => {
    const board = createBoard(3);
    const removableStatusId = board.statuses[2].id;
    const deleted = deleteStatusFromBoard(board, removableStatusId);

    assert.deepEqual(
        deleted.statuses.map((status) => status.order),
        [0, 1]
    );
    assert.throws(
        () => deleteStatusFromBoard(board, firstStatusId),
        /此狀態仍有任務/
    );
    assert.throws(
        () => deleteStatusFromBoard(createBoard(), '20000000-0000-4000-8000-000000000002'),
        /至少需要/
    );
    assert.doesNotThrow(() => validateBoard(deleted));
});

test('creates and updates tags with stable IDs and globally unique names', () => {
    const board = createBoard();
    const added = addTagToBoard(board, {
        name: 'POL · Policy'
    });
    const tag = added.tags[1];

    assert.match(tag.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.throws(() => addTagToBoard(added, {
        name: 'pol · POLICY'
    }));

    const updated = updateTagOnBoard(added, tag.id, {
        name: 'Policy'
    });
    assert.equal(updated.tags[1].id, tag.id);
    assert.equal(updated.tags[1].name, 'Policy');
    assert.throws(() => addTagToBoard(board, { name: '  ' }));
    assert.doesNotThrow(() => validateBoard(updated));
});

test('deletes a tag and removes it from all tickets that use it', () => {
    const board = addTagToBoard(createBoard(), {
        name: 'Unused'
    });
    const unusedId = board.tags[1].id;

    const deletedUsedTag = deleteTagFromBoard(board, tagId);
    assert.deepEqual(deletedUsedTag.tags.map((tag) => tag.id), [unusedId]);
    assert.ok(deletedUsedTag.tickets.every((ticket) =>
        !ticket.tagIds.includes(tagId)
    ));
    assert.doesNotThrow(() => validateBoard(deletedUsedTag));

    const deleted = deleteTagFromBoard(board, unusedId);

    assert.deepEqual(deleted.tags.map((tag) => tag.id), [tagId]);
    assert.doesNotThrow(() => validateBoard(deleted));
});

test('loads valid JSON and rejects malformed JSON without modifying it', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuolaflow-board-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    const filePath = path.join(directory, 'board.json');
    const board = createBoard();
    await fs.writeFile(filePath, JSON.stringify(board), 'utf8');
    assert.deepEqual(await loadBoard(filePath), board);

    const malformedContent = '{"schemaVersion":';
    await fs.writeFile(filePath, malformedContent, 'utf8');
    await assert.rejects(loadBoard(filePath), /JSON/);
    assert.equal(await fs.readFile(filePath, 'utf8'), malformedContent);
});

test('rejects a missing board file without creating one', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuolaflow-board-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    const filePath = path.join(directory, 'missing-board.json');
    await assert.rejects(loadBoard(filePath), /找不到看板資料檔案/);
    await assert.rejects(fs.access(filePath));
});

test('saves valid data and preserves the existing file after invalid updates', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuolaflow-board-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    const filePath = path.join(directory, 'board.json');
    const originalBoard = createBoard();
    await fs.writeFile(filePath, JSON.stringify(originalBoard), 'utf8');

    const updatedBoard = createBoard();
    updatedBoard.tickets[0].title = 'Updated';
    await saveBoard(filePath, updatedBoard);
    assert.deepEqual(await loadBoard(filePath), updatedBoard);

    const savedContent = await fs.readFile(filePath, 'utf8');
    const invalidBoard = createBoard();
    invalidBoard.tickets[0].dueDate = '2023-02-29';
    await assert.rejects(saveBoard(filePath, invalidBoard));
    assert.equal(await fs.readFile(filePath, 'utf8'), savedContent);

    const malformedContent = '{"schemaVersion":';
    await fs.writeFile(filePath, malformedContent, 'utf8');
    await assert.rejects(saveBoard(filePath, updatedBoard));
    assert.equal(await fs.readFile(filePath, 'utf8'), malformedContent);
});

test('persists tag and workflow updates across reloads', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuolaflow-board-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    const filePath = path.join(directory, 'board.json');
    await fs.writeFile(filePath, JSON.stringify(createBoard()), 'utf8');
    let board = await loadBoard(filePath);

    board = addStatusToBoard(board, 'Review');
    const status = board.statuses.find((item) => item.name === 'Review');
    board = renameStatusOnBoard(board, status.id, 'Quality Check');

    board = addTagToBoard(board, {
        name: 'Urgent'
    });
    const tag = board.tags[1];
    board = updateTagOnBoard(board, tag.id, {
        name: 'Critical'
    });

    board = updateTicketOnBoard(board, ticketId, {
        title: 'Persisted ticket update',
        description: 'Updated with shared tags',
        tagIds: [tagId, tag.id],
        statusId: status.id,
        dueDate: null
    });
    await saveBoard(filePath, board);

    const reloadedBoard = await loadBoard(filePath);
    const reloadedTicket = reloadedBoard.tickets.find((item) => item.id === ticketId);

    assert.equal(
        reloadedBoard.statuses.find((item) => item.id === status.id).name,
        'Quality Check'
    );
    assert.deepEqual(
        reloadedBoard.tags.find((item) => item.id === tag.id),
        { id: tag.id, name: 'Critical' }
    );
    assert.equal(reloadedTicket.title, 'Persisted ticket update');
    assert.deepEqual(reloadedTicket.tagIds, [tagId, tag.id]);
    assert.equal(reloadedTicket.statusId, status.id);
    assert.doesNotThrow(() => validateBoard(reloadedBoard));
});

test('rejects version 1 boards without modifying the original file', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuolaflow-board-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    const filePath = path.join(directory, 'board.json');
    const unsupportedBoard = {
        schemaVersion: 1,
        systems: [],
        members: [],
        statuses: [],
        tickets: []
    };
    const originalContent = JSON.stringify(unsupportedBoard);
    await fs.writeFile(filePath, originalContent, 'utf8');

    await assert.rejects(loadBoard(filePath), /不支援的資料版本：1/);
    assert.equal(await fs.readFile(filePath, 'utf8'), originalContent);
});
