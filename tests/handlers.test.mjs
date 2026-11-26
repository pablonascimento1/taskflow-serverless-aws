// Testes das Lambdas com DynamoDB e Cognito SIMULADOS em memória (não acessa a AWS).
// Rode com: npm install && npm test
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

process.env.TABLE_NAME = 'tasks-test';
process.env.USER_POOL_ID = 'pool-test';

// ---------- DynamoDB falso ----------
const db = new Map();
DynamoDBDocumentClient.prototype.send = async function (cmd) {
  const i = cmd.input;
  const v = i.ExpressionAttributeValues || {};
  switch (cmd.constructor.name) {
    case 'GetCommand': return { Item: db.get(i.Key.id) };
    case 'PutCommand': db.set(i.Item.id, { ...i.Item }); return {};
    case 'DeleteCommand': db.delete(i.Key.id); return {};
    case 'UpdateCommand': {
      const item = { ...db.get(i.Key.id), title: v[':t'], description: v[':d'], status: v[':s'], updatedAt: v[':u'] };
      db.set(item.id, item);
      return { Attributes: item };
    }
    case 'QueryCommand': {
      let items = [...db.values()].filter((t) => t.userId === v[':u']);
      if (v[':s']) items = items.filter((t) => t.status === v[':s']);
      return { Items: items };
    }
    case 'ScanCommand': {
      let items = [...db.values()];
      if (v[':s']) items = items.filter((t) => t.status === v[':s']);
      return { Items: items, Count: items.length };
    }
  }
  throw new Error(`Comando não simulado: ${cmd.constructor.name}`);
};

// ---------- Cognito falso ----------
const users = {
  u1: { name: 'Ana', email: 'ana@example.com' },
  u2: { name: 'Bia', email: 'bia@example.com' },
  adm: { name: 'Admin', email: 'admin@example.com' },
};
const adminGroup = new Set(['adm']);
CognitoIdentityProviderClient.prototype.send = async function (cmd) {
  const i = cmd.input;
  const toUser = (id) => ({
    Username: id,
    Attributes: [{ Name: 'name', Value: users[id].name }, { Name: 'email', Value: users[id].email }],
    UserCreateDate: new Date(),
  });
  switch (cmd.constructor.name) {
    case 'ListUsersCommand': return { Users: Object.keys(users).map(toUser) };
    case 'ListUsersInGroupCommand': return { Users: [...adminGroup].map(toUser) };
    case 'AdminGetUserCommand':
      if (!users[i.Username]) throw Object.assign(new Error('not found'), { name: 'UserNotFoundException' });
      return {};
    case 'AdminAddUserToGroupCommand': adminGroup.add(i.Username); return {};
    case 'AdminRemoveUserFromGroupCommand': adminGroup.delete(i.Username); return {};
    case 'AdminDeleteUserCommand': delete users[i.Username]; return {};
  }
  throw new Error(`Comando não simulado: ${cmd.constructor.name}`);
};

console.log = () => {}; // silencia os logs das Lambdas

const tasks = (await import('../src/tasks.mjs')).handler;
const usersApi = (await import('../src/users.mjs')).handler;
const publicApi = (await import('../src/public.mjs')).handler;

// Monta um evento igual ao que o API Gateway entrega à Lambda
const event = (method, resource, { user, body, id, qs } = {}) => ({
  httpMethod: method,
  resource,
  path: resource.replace('{id}', id || ''),
  pathParameters: id ? { id } : null,
  queryStringParameters: qs || null,
  body: body ? JSON.stringify(body) : null,
  requestContext: {
    authorizer: {
      claims: user
        ? { sub: user, email: users[user]?.email, name: users[user]?.name, 'cognito:groups': adminGroup.has(user) ? 'admin' : undefined }
        : {},
    },
  },
});
const body = (res) => (res.body ? JSON.parse(res.body) : null);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  process.stdout.write(`  ✔ ${name}\n`);
}

let t1, t2;

await test('rotas públicas respondem 200', async () => {
  assert.equal((await publicApi(event('GET', '/health'))).statusCode, 200);
  assert.equal((await publicApi(event('GET', '/'))).statusCode, 200);
});

await test('POST /tasks cria tarefa (201 + Location)', async () => {
  const res = await tasks(event('POST', '/tasks', { user: 'u1', body: { title: 'Estudar SD', description: 'Lambda' } }));
  assert.equal(res.statusCode, 201);
  t1 = body(res);
  assert.equal(res.headers.Location, `/tasks/${t1.id}`);
  assert.equal(t1.ownerName, 'Ana');
  assert.equal(t1.status, 'pendente');
  t2 = body(await tasks(event('POST', '/tasks', { user: 'u2', body: { title: 'Tarefa da Bia' } })));
});

await test('POST /tasks valida título e JSON (400)', async () => {
  assert.equal((await tasks(event('POST', '/tasks', { user: 'u1', body: { title: '   ' } }))).statusCode, 400);
  assert.equal((await tasks({ ...event('POST', '/tasks', { user: 'u1' }), body: '{json quebrado' })).statusCode, 400);
});

await test('usuário comum lista só as próprias tarefas; admin lista todas', async () => {
  assert.equal(body(await tasks(event('GET', '/tasks', { user: 'u1' }))).length, 1);
  assert.equal(body(await tasks(event('GET', '/tasks', { user: 'adm' }))).length, 2);
});

await test('acesso à tarefa de outro usuário é negado (403); admin pode', async () => {
  assert.equal((await tasks(event('GET', '/tasks/{id}', { user: 'u2', id: t1.id }))).statusCode, 403);
  assert.equal((await tasks(event('PATCH', '/tasks/{id}', { user: 'u2', id: t1.id, body: { status: 'concluida' } }))).statusCode, 403);
  assert.equal((await tasks(event('DELETE', '/tasks/{id}', { user: 'u2', id: t1.id }))).statusCode, 403);
  assert.equal((await tasks(event('GET', '/tasks/{id}', { user: 'adm', id: t1.id }))).statusCode, 200);
});

await test('tarefa inexistente retorna 404', async () => {
  assert.equal((await tasks(event('GET', '/tasks/{id}', { user: 'u1', id: 'nao-existe' }))).statusCode, 404);
});

await test('PATCH /tasks/{id} faz atualização parcial e valida status', async () => {
  const res = await tasks(event('PATCH', '/tasks/{id}', { user: 'u1', id: t1.id, body: { status: 'concluida' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).status, 'concluida');
  assert.equal(body(res).title, 'Estudar SD');
  assert.equal((await tasks(event('PATCH', '/tasks/{id}', { user: 'u1', id: t1.id, body: { status: 'xyz' } }))).statusCode, 400);
});

await test('filtro ?status= funciona', async () => {
  assert.equal(body(await tasks(event('GET', '/tasks', { user: 'adm', qs: { status: 'concluida' } }))).length, 1);
  assert.equal(body(await tasks(event('GET', '/tasks', { user: 'u1', qs: { status: 'pendente' } }))).length, 0);
  assert.equal((await tasks(event('GET', '/tasks', { user: 'u1', qs: { status: 'invalido' } }))).statusCode, 400);
});

await test('GET /users/me devolve o usuário do token', async () => {
  const me = body(await usersApi(event('GET', '/users/me', { user: 'u1' })));
  assert.deepEqual(me, { id: 'u1', email: 'ana@example.com', name: 'Ana', role: 'user' });
});

await test('rotas de admin negam usuário comum (403)', async () => {
  assert.equal((await usersApi(event('GET', '/users', { user: 'u1' }))).statusCode, 403);
  assert.equal((await usersApi(event('DELETE', '/users/{id}', { user: 'u1', id: 'u2' }))).statusCode, 403);
});

await test('GET /users lista usuários com contagem de tarefas', async () => {
  const res = await usersApi(event('GET', '/users', { user: 'adm' }));
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).find((u) => u.id === 'u1').taskCount, 1);
});

await test('PATCH /users/{id} altera papel e protege o próprio admin', async () => {
  assert.equal((await usersApi(event('PATCH', '/users/{id}', { user: 'adm', id: 'adm', body: { role: 'user' } }))).statusCode, 400);
  assert.equal((await usersApi(event('PATCH', '/users/{id}', { user: 'adm', id: 'zz', body: { role: 'admin' } }))).statusCode, 404);
  assert.equal((await usersApi(event('PATCH', '/users/{id}', { user: 'adm', id: 'u1', body: { role: 'admin' } }))).statusCode, 200);
  assert.ok(adminGroup.has('u1'));
});

await test('DELETE /users/{id} remove o usuário e as tarefas dele', async () => {
  assert.equal((await usersApi(event('DELETE', '/users/{id}', { user: 'adm', id: 'u2' }))).statusCode, 204);
  assert.ok(!db.has(t2.id));
});

await test('DELETE /tasks/{id} remove a tarefa (204)', async () => {
  assert.equal((await tasks(event('DELETE', '/tasks/{id}', { user: 'u1', id: t1.id }))).statusCode, 204);
  assert.equal(db.size, 0);
});

process.stdout.write(`\n${passed} testes passaram\n`);
