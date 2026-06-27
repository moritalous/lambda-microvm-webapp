function hasMvmSessionCookie(headers) {
  const cookies = headers.cookie || [];
  return cookies.some((h) => /(?:^|;\s*)mvm-session=/.test(h.value));
}

function isHtmlNavigation(headers) {
  const accept = headers.accept || [];
  return accept.some((h) => h.value.includes('text/html'));
}

exports.handler = async (event) => {
  const { request, response } = event.Records[0].cf;
  const status = parseInt(response.status, 10);

  const recoverable = status === 502 || status === 504;

  if (recoverable && hasMvmSessionCookie(request.headers) && isHtmlNavigation(request.headers)) {
    return {
      status: '302',
      statusDescription: 'Found',
      headers: {
        location: [{ key: 'Location', value: '/session/start' }],
        'set-cookie': [
          {
            key: 'Set-Cookie',
            value: 'mvm-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
          },
        ],
        'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
      },
    };
  }

  return response;
};
