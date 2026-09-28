const BASE = 'http://127.0.0.1:8787';

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log("Logging in as physics@cbt.local with new password...");
  const loginRes = await api('/auth/login', {
    method: 'POST',
    body: { email: 'physics@cbt.local', password: 'physics5_pass' }
  });
  console.log('Login Status:', loginRes.status);
  
  if (loginRes.status !== 200) {
    console.log('Login Failed:', loginRes.data);
    return;
  }
  const token = loginRes.data.token;
  
  console.log("\nAttempting to fetch biology questions as physics faculty...");
  const fetchBioRes = await api('/questions?subject=biology', { token });
  console.log('Status Code:', fetchBioRes.status);
  console.log('Response Body:', fetchBioRes.data);
}

run();
