const cfg = require('./config.json');

const {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
} = require('@aws-sdk/client-lambda-microvms');
const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { randomUUID } = require('node:crypto');

const MVM_REGION = cfg.MVM_REGION;
const mvm = new LambdaMicrovmsClient({ region: MVM_REGION });
const ddb = new DynamoDBClient({ region: MVM_REGION });

const TABLE = cfg.TABLE;
const IMAGE_ARN = cfg.IMAGE_ARN;
const INGRESS = cfg.INGRESS;
const EGRESS = cfg.EGRESS;

const TOKEN_DURATION_MIN = cfg.TOKEN_DURATION_MIN;
const TOKEN_REFRESH_THRESHOLD = cfg.TOKEN_REFRESH_THRESHOLD;
const MAX_DURATION_SEC = cfg.MAX_DURATION_SEC;
const IDLE_SEC = cfg.IDLE_SEC;
const SUSPENDED_SEC = cfg.SUSPENDED_SEC;

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies['mvm-session'];

  if (request.uri === '/session/start') {
    const id = randomUUID();
    const run = await mvm.send(
      new RunMicrovmCommand({
        imageIdentifier: IMAGE_ARN,
        ingressNetworkConnectors: [INGRESS],
        egressNetworkConnectors: [EGRESS],
        idlePolicy: {
          autoResumeEnabled: true,
          maxIdleDurationSeconds: IDLE_SEC,
          suspendedDurationSeconds: SUSPENDED_SEC,
        },
        maximumDurationInSeconds: MAX_DURATION_SEC,
      }),
    );

    const tokenResp = await mvm.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: run.microvmId,
        expirationInMinutes: TOKEN_DURATION_MIN,
        allowedPorts: [{ port: 8080 }],
      }),
    );
    const token = tokenResp.authToken['X-aws-proxy-auth'];

    const now = Date.now();
    const ttl = Math.floor(now / 1000) + MAX_DURATION_SEC + 3600;
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          sessionId: { S: id },
          microvmId: { S: run.microvmId },
          endpoint: { S: run.endpoint },
          token: { S: token },
          tokenExpiry: { N: String(now + TOKEN_DURATION_MIN * 60000) },
          ttl: { N: String(ttl) },
        },
      }),
    );

    return {
      status: '200',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/html' }],
        'set-cookie': [
          {
            key: 'Set-Cookie',
            value: `mvm-session=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${MAX_DURATION_SEC}`,
          },
        ],
        'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      },
      body: [
        "<!DOCTYPE html><html><head><meta charset='utf-8'>",
        '<title>Starting application...</title>',
        '<style>body{font-family:system-ui;display:flex;flex-direction:column;justify-content:center;',
        'align-items:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc}',
        '.spinner{border:4px solid #333;border-top:4px solid #007acc;border-radius:50%;',
        'width:40px;height:40px;animation:spin 1s linear infinite;margin-bottom:20px}',
        '@keyframes spin{to{transform:rotate(360deg)}}</style></head>',
        "<body><div class='spinner'></div>",
        '<p>Starting your application...</p>',
        "<p style='font-size:0.8em;color:#888'>This takes about 10 seconds</p>",
        "<script>setTimeout(()=>location.href='/',10000)</script>",
        '</body></html>',
      ].join(''),
    };
  }

  if (!sessionId) {
    return { status: '302', headers: { location: [{ key: 'Location', value: '/session/start' }] } };
  }

  const result = await ddb.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { sessionId: { S: sessionId } },
    }),
  );
  if (!result.Item) {
    return {
      status: '302',
      headers: {
        location: [{ key: 'Location', value: '/session/start' }],
        'set-cookie': [{ key: 'Set-Cookie', value: 'mvm-session=; Path=/; Secure; HttpOnly; Max-Age=0' }],
      },
    };
  }

  let token = result.Item.token.S;
  const expiry = Number(result.Item.tokenExpiry.N);
  if (Date.now() > expiry - TOKEN_REFRESH_THRESHOLD * 60000) {
    try {
      const r = await mvm.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: result.Item.microvmId.S,
          expirationInMinutes: TOKEN_DURATION_MIN,
          allowedPorts: [{ port: 8080 }],
        }),
      );
      token = r.authToken['X-aws-proxy-auth'];
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { sessionId: { S: sessionId } },
          UpdateExpression: 'SET #t = :t, tokenExpiry = :e',
          ExpressionAttributeNames: { '#t': 'token' },
          ExpressionAttributeValues: {
            ':t': { S: token },
            ':e': { N: String(Date.now() + TOKEN_DURATION_MIN * 60000) },
          },
        }),
      );
    } catch (err) {
      console.error('Token refresh failed:', err);
    }
  }

  const host = result.Item.endpoint.S;
  request.origin = {
    custom: {
      domainName: host,
      port: 443,
      protocol: 'https',
      path: '',
      sslProtocols: ['TLSv1.2'],
      readTimeout: 60,
      keepaliveTimeout: 60,
    },
  };
  request.headers.host = [{ key: 'Host', value: host }];
  request.headers['x-aws-proxy-auth'] = [{ key: 'X-aws-proxy-auth', value: token }];
  request.headers.origin = [{ key: 'Origin', value: `https://${host}` }];
  return request;
};

function parseCookies(cookieHeader) {
  if (!cookieHeader?.[0]) return {};
  return cookieHeader[0].value.split(';').reduce((acc, c) => {
    const eq = c.indexOf('=');
    if (eq > 0) acc[c.substring(0, eq).trim()] = c.substring(eq + 1).trim();
    return acc;
  }, {});
}
