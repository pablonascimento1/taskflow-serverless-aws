// Recurso /tasks — CRUD de tarefas
// Regra de negócio (AUTORIZAÇÃO): o usuário comum só enxerga e altera as PRÓPRIAS
// tarefas; quem está no grupo "admin" do Cognito enxerga e altera todas.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, json, currentUser, parseBody, withErrors } from './common.mjs';

const STATUSES = ['pendente', 'em_andamento', 'concluida'];

// Lê todas as páginas de um Query/Scan
async function readAll(makeCommand) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(makeCommand(ExclusiveStartKey));
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Busca a tarefa e aplica as regras de acesso -> { task } ou { error: resposta 404/403 }
async function loadTask(id, user) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  if (!Item) return { error: json(404, { error: 'Tarefa não encontrada' }) };
  if (user.role !== 'admin' && Item.userId !== user.id) {
    return { error: json(403, { error: 'Esta tarefa pertence a outro usuário' }) };
  }
  return { task: Item };
}

// GET /tasks?status=pendente
async function listTasks(event, user) {
  const status = event.queryStringParameters?.status;
  if (status && !STATUSES.includes(status)) return json(400, { error: 'status inválido' });

  const filter = status
    ? { FilterExpression: '#s = :s', ExpressionAttributeNames: { '#s': 'status' } }
    : {};
  const statusValue = status ? { ':s': status } : {};

  let tasks;
  if (user.role === 'admin') {
    tasks = await readAll((key) => new ScanCommand({
      TableName: TABLE, ExclusiveStartKey: key, ...filter,
      ...(status ? { ExpressionAttributeValues: statusValue } : {}),
    }));
  } else {
    tasks = await readAll((key) => new QueryCommand({
      TableName: TABLE, IndexName: 'byUser', ExclusiveStartKey: key,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': user.id, ...statusValue },
      ...filter,
    }));
  }
  tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(200, tasks);
}

// POST /tasks  { title, description? }
async function createTask(event, user) {
  const body = parseBody(event);
  if (body === null) return json(400, { error: 'JSON inválido' });
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  if (!title) return json(400, { error: 'O título é obrigatório' });
  if (title.length > 200) return json(400, { error: 'Título muito longo (máx. 200)' });

  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    userId: user.id,
    ownerName: user.name,
    title,
    description,
    status: 'pendente',
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: task }));
  return json(201, task, { Location: `/tasks/${task.id}` });
}

// PATCH /tasks/{id}  { title?, description?, status? } — atualização parcial
async function updateTask(event, user) {
  const body = parseBody(event);
  if (body === null) return json(400, { error: 'JSON inválido' });
  const { task, error } = await loadTask(event.pathParameters.id, user);
  if (error) return error;

  const title = body.title !== undefined ? String(body.title).trim() : task.title;
  const description = body.description !== undefined ? String(body.description).trim() : task.description;
  const status = body.status ?? task.status;
  if (!title) return json(400, { error: 'O título não pode ficar vazio' });
  if (!STATUSES.includes(status)) return json(400, { error: `status deve ser: ${STATUSES.join(', ')}` });

  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { id: task.id },
    UpdateExpression: 'SET #t = :t, #d = :d, #s = :s, #u = :u',
    ExpressionAttributeNames: { '#t': 'title', '#d': 'description', '#s': 'status', '#u': 'updatedAt' },
    ExpressionAttributeValues: { ':t': title, ':d': description, ':s': status, ':u': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  return json(200, Attributes);
}

// DELETE /tasks/{id}
async function deleteTask(event, user) {
  const { task, error } = await loadTask(event.pathParameters.id, user);
  if (error) return error;
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { id: task.id } }));
  return json(204);
}

export const handler = withErrors(async (event) => {
  const user = currentUser(event);
  switch (`${event.httpMethod} ${event.resource}`) {
    case 'GET /tasks': return listTasks(event, user);
    case 'POST /tasks': return createTask(event, user);
    case 'GET /tasks/{id}': {
      const { task, error } = await loadTask(event.pathParameters.id, user);
      return error || json(200, task);
    }
    case 'PATCH /tasks/{id}': return updateTask(event, user);
    case 'DELETE /tasks/{id}': return deleteTask(event, user);
    default: return json(404, { error: 'Recurso não encontrado' });
  }
});
