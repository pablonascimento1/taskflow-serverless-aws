// Utilitários compartilhados pelas Lambdas da camada de negócios
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const TABLE = process.env.TABLE_NAME;

// Resposta HTTP no formato esperado pelo API Gateway (integração proxy)
export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

// Quem está chamando? O API Gateway já validou o token do Cognito (AUTENTICAÇÃO)
// e repassa as "claims" do token para a Lambda.
export function currentUser(event) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const groups = String(claims['cognito:groups'] || '');
  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
    role: /\badmin\b/.test(groups) ? 'admin' : 'user',
  };
}

export function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
    return JSON.parse(raw) ?? {};
  } catch {
    return null;
  }
}

// Envolve o handler: registra a chamada no CloudWatch e trata erros inesperados
export const withErrors = (fn) => async (event) => {
  let res;
  try {
    res = await fn(event);
  } catch (err) {
    console.error(err);
    res = json(500, { error: 'Erro interno do servidor' });
  }
  console.log(`${event.httpMethod} ${event.path} -> ${res.statusCode}`);
  return res;
};
