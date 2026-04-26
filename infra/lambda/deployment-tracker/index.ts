import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DAYS_IN_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_DAYS = 3650; // 10 years

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { project, environment } = event.pathParameters ?? {};

  if (!project || !environment) {
    return json(400, { error: 'project and environment path parameters are required' });
  }

  const projectEnv = `${project}#${environment}`;
  const isLatest = event.resource?.endsWith('/latest');

  switch (event.httpMethod) {
    case 'PUT':  return handlePut(projectEnv, event.body);
    case 'GET':  return handleGet(projectEnv, isLatest ?? false);
    default:     return json(405, { error: 'Method not allowed' });
  }
};

async function handlePut(projectEnv: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { version, commitHash, branch, deployedBy, ttlDays } = body as {
    version?: string;
    commitHash?: string;
    branch?: string;
    deployedBy?: string;
    ttlDays?: number;
  };

  if (!version || !commitHash) {
    return json(400, { error: 'version and commitHash are required' });
  }

  const deployedAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + (Number(ttlDays) || DEFAULT_TTL_DAYS) * DAYS_IN_SECONDS;

  await ddb.send(new PutCommand({
    TableName: process.env.TABLE_NAME!,
    Item: { projectEnv, deployedAt, version, commitHash, branch, deployedBy, ttl },
  }));

  return json(200, { projectEnv, deployedAt, version });
}

async function handleGet(projectEnv: string, latestOnly: boolean): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new QueryCommand({
    TableName: process.env.TABLE_NAME!,
    KeyConditionExpression: 'projectEnv = :pk',
    ExpressionAttributeValues: { ':pk': projectEnv },
    ScanIndexForward: false,
    Limit: latestOnly ? 1 : 20,
  }));

  const items = result.Items ?? [];

  if (latestOnly) {
    return items.length === 0
      ? json(404, { error: 'No deployments found' })
      : json(200, items[0]);
  }

  return json(200, { items, lastEvaluatedKey: result.LastEvaluatedKey ?? null });
}
