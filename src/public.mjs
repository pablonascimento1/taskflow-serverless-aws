// Rotas públicas (sem token): descrição da API e verificação de saúde
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, json, withErrors } from './common.mjs';

const RESOURCES = {
  'GET /': 'público — esta descrição',
  'GET /health': 'público — status da API e do banco',
  'GET /users/me': 'autenticado',
  'GET /users': 'admin',
  'PATCH /users/{id}': 'admin — altera papel (user/admin)',
  'DELETE /users/{id}': 'admin',
  'GET /tasks?status=': 'autenticado (admin vê todas)',
  'POST /tasks': 'autenticado',
  'GET /tasks/{id}': 'dono ou admin',
  'PATCH /tasks/{id}': 'dono ou admin',
  'DELETE /tasks/{id}': 'dono ou admin',
};

export const handler = withErrors(async (event) => {
  if (event.resource === '/health') {
    try {
      await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 1, Select: 'COUNT' }));
      return json(200, { api: 'ok', database: 'ok', time: new Date().toISOString() });
    } catch (err) {
      console.error(err);
      return json(503, { api: 'ok', database: 'indisponível' });
    }
  }
  return json(200, {
    name: 'TaskFlow API',
    auth: 'Envie o ID token do Cognito no cabeçalho Authorization',
    resources: RESOURCES,
  });
});
