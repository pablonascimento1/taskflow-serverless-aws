// Recurso /users — perfil próprio e administração de usuários (dados vêm do Cognito)
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ScanCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, json, currentUser, parseBody, withErrors } from './common.mjs';

const cognito = new CognitoIdentityProviderClient({});
const POOL = process.env.USER_POOL_ID;

const attr = (u, name) => (u.Attributes || u.UserAttributes || []).find((a) => a.Name === name)?.Value;

async function userExists(id) {
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: id }));
    return true;
  } catch (err) {
    if (err.name === 'UserNotFoundException') return false;
    throw err;
  }
}

// GET /users — somente admin
async function listUsers() {
  const users = [];
  let PaginationToken;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, PaginationToken }));
    users.push(...page.Users);
    PaginationToken = page.PaginationToken;
  } while (PaginationToken);

  const admins = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: POOL, GroupName: 'admin' }));
  const adminIds = new Set(admins.Users.map((u) => u.Username));

  // Conta quantas tarefas cada usuário tem
  const counts = {};
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE, ProjectionExpression: 'userId', ExclusiveStartKey }));
    for (const t of page.Items) counts[t.userId] = (counts[t.userId] || 0) + 1;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return json(200, users
    .map((u) => ({
      id: u.Username,
      name: attr(u, 'name'),
      email: attr(u, 'email'),
      role: adminIds.has(u.Username) ? 'admin' : 'user',
      createdAt: u.UserCreateDate,
      taskCount: counts[u.Username] || 0,
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
}

// PATCH /users/{id}  { role: 'user' | 'admin' } — somente admin
async function updateRole(event, me) {
  const id = event.pathParameters.id;
  const body = parseBody(event);
  if (!body || !['user', 'admin'].includes(body.role)) {
    return json(400, { error: "role deve ser 'user' ou 'admin'" });
  }
  if (id === me.id) return json(400, { error: 'Você não pode alterar o seu próprio papel' });
  if (!(await userExists(id))) return json(404, { error: 'Usuário não encontrado' });

  const Command = body.role === 'admin' ? AdminAddUserToGroupCommand : AdminRemoveUserFromGroupCommand;
  await cognito.send(new Command({ UserPoolId: POOL, Username: id, GroupName: 'admin' }));
  return json(200, { id, role: body.role, note: 'O novo papel vale a partir do próximo login do usuário' });
}

// DELETE /users/{id} — somente admin (remove também as tarefas do usuário)
async function deleteUser(event, me) {
  const id = event.pathParameters.id;
  if (id === me.id) return json(400, { error: 'Você não pode remover a si mesmo' });
  if (!(await userExists(id))) return json(404, { error: 'Usuário não encontrado' });

  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: id }));

  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE, IndexName: 'byUser', KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': id }, ProjectionExpression: 'id', ExclusiveStartKey,
    }));
    for (const t of page.Items) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { id: t.id } }));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return json(204);
}

export const handler = withErrors(async (event) => {
  const me = currentUser(event);
  const route = `${event.httpMethod} ${event.resource}`;

  if (route === 'GET /users/me') return json(200, me);

  // Daqui para baixo: AUTORIZAÇÃO — somente administradores
  if (me.role !== 'admin') return json(403, { error: 'Você não tem permissão para este recurso' });

  switch (route) {
    case 'GET /users': return listUsers();
    case 'PATCH /users/{id}': return updateRole(event, me);
    case 'DELETE /users/{id}': return deleteUser(event, me);
    default: return json(404, { error: 'Recurso não encontrado' });
  }
});
