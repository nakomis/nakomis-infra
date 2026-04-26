import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/deployment-tracker/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeAll(() => {
  process.env.TABLE_NAME = 'test-deployments';
});

beforeEach(() => {
  ddbMock.reset();
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    resource: '/deployments/{project}/{environment}',
    pathParameters: { project: 'nakostat-web', environment: 'sandbox' },
    body: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    path: '/deployments/nakostat-web/sandbox',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    ...overrides,
  };
}

describe('PUT /deployments/{project}/{environment}', () => {
  test('records a deployment and returns 200', async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(makeEvent({
      httpMethod: 'PUT',
      body: JSON.stringify({ version: '0.1.0', commitHash: 'abc123', branch: 'main', deployedBy: 'github-actions' }),
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.projectEnv).toBe('nakostat-web#sandbox');
    expect(body.version).toBe('0.1.0');
    expect(body.deployedAt).toBeDefined();
  });

  test('sets TTL ~10 years by default', async () => {
    let capturedItem: Record<string, unknown> = {};
    ddbMock.on(PutCommand).callsFake((input) => {
      capturedItem = (input as { Item?: Record<string, unknown> }).Item ?? {};
      return {};
    });

    await handler(makeEvent({
      httpMethod: 'PUT',
      body: JSON.stringify({ version: '0.1.0', commitHash: 'abc123' }),
    }));

    const nowSecs = Math.floor(Date.now() / 1000);
    const tenYearsSecs = 3650 * 24 * 60 * 60;
    expect(capturedItem.ttl).toBeGreaterThan(nowSecs + tenYearsSecs - 60);
    expect(capturedItem.ttl).toBeLessThan(nowSecs + tenYearsSecs + 60);
  });

  test('respects custom ttlDays', async () => {
    let capturedItem: Record<string, unknown> = {};
    ddbMock.on(PutCommand).callsFake((input) => {
      capturedItem = (input as { Item?: Record<string, unknown> }).Item ?? {};
      return {};
    });

    await handler(makeEvent({
      httpMethod: 'PUT',
      body: JSON.stringify({ version: '0.1.0', commitHash: 'abc123', ttlDays: 365 }),
    }));

    const nowSecs = Math.floor(Date.now() / 1000);
    const oneYearSecs = 365 * 24 * 60 * 60;
    expect(capturedItem.ttl).toBeGreaterThan(nowSecs + oneYearSecs - 60);
    expect(capturedItem.ttl).toBeLessThan(nowSecs + oneYearSecs + 60);
  });

  test('returns 400 when version is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'PUT',
      body: JSON.stringify({ commitHash: 'abc123' }),
    }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 when commitHash is missing', async () => {
    const result = await handler(makeEvent({
      httpMethod: 'PUT',
      body: JSON.stringify({ version: '0.1.0' }),
    }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 for invalid JSON body', async () => {
    const result = await handler(makeEvent({ httpMethod: 'PUT', body: 'not-json' }));
    expect(result.statusCode).toBe(400);
  });
});

describe('GET /deployments/{project}/{environment}/latest', () => {
  test('returns the most recent deployment', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ projectEnv: 'nakostat-web#sandbox', deployedAt: '2026-04-26T12:00:00Z', version: '0.1.0' }],
    });

    const result = await handler(makeEvent({
      httpMethod: 'GET',
      resource: '/deployments/{project}/{environment}/latest',
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).version).toBe('0.1.0');
  });

  test('returns 404 when no deployments exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await handler(makeEvent({
      httpMethod: 'GET',
      resource: '/deployments/{project}/{environment}/latest',
    }));
    expect(result.statusCode).toBe(404);
  });

  test('queries with ScanIndexForward=false and Limit=1', async () => {
    let capturedInput: Record<string, unknown> = {};
    ddbMock.on(QueryCommand).callsFake((input) => {
      capturedInput = input as Record<string, unknown>;
      return { Items: [{ projectEnv: 'nakostat-web#sandbox', deployedAt: '2026-04-26T12:00:00Z', version: '0.1.0' }] };
    });

    await handler(makeEvent({
      httpMethod: 'GET',
      resource: '/deployments/{project}/{environment}/latest',
    }));

    expect(capturedInput.ScanIndexForward).toBe(false);
    expect(capturedInput.Limit).toBe(1);
  });
});

describe('GET /deployments/{project}/{environment} (history)', () => {
  test('returns a list of deployments', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { projectEnv: 'nakostat-web#sandbox', deployedAt: '2026-04-26T12:00:00Z', version: '0.1.1' },
        { projectEnv: 'nakostat-web#sandbox', deployedAt: '2026-04-25T10:00:00Z', version: '0.1.0' },
      ],
    });

    const result = await handler(makeEvent({ httpMethod: 'GET' }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.items).toHaveLength(2);
    expect(body.lastEvaluatedKey).toBeNull();
  });

  test('includes lastEvaluatedKey when more pages exist', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: { projectEnv: 'nakostat-web#sandbox', deployedAt: '2026-01-01T00:00:00Z' },
    });

    const result = await handler(makeEvent({ httpMethod: 'GET' }));
    expect(JSON.parse(result.body).lastEvaluatedKey).toBeDefined();
  });
});

describe('missing path parameters', () => {
  test('returns 400 when project is missing', async () => {
    const result = await handler(makeEvent({ pathParameters: { environment: 'sandbox' } }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 when environment is missing', async () => {
    const result = await handler(makeEvent({ pathParameters: { project: 'nakostat-web' } }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 when pathParameters is null', async () => {
    const result = await handler(makeEvent({ pathParameters: null }));
    expect(result.statusCode).toBe(400);
  });
});

describe('unsupported method', () => {
  test('returns 405', async () => {
    const result = await handler(makeEvent({ httpMethod: 'DELETE' }));
    expect(result.statusCode).toBe(405);
  });
});

describe('edge cases', () => {
  test('GET with undefined resource falls back to history (not latest)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ projectEnv: 'nakostat-web#sandbox', deployedAt: '2026-04-26T12:00:00Z', version: '0.1.0' }],
    });

    // resource is undefined — isLatest should be false, returning history format
    const result = await handler(makeEvent({ httpMethod: 'GET', resource: undefined }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.items).toBeDefined();
  });
});
