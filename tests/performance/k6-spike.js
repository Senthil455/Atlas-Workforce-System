import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const payrollRunDuration = new Trend('payroll_run_duration');

export const options = {
  stages: [
    { duration: '1m', target: 5 },
    { duration: '10s', target: 200 },
    { duration: '2m', target: 200 },
    { duration: '10s', target: 5 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.01'],
    payroll_run_duration: ['p(95)<5000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_URL = __ENV.AUTH_URL || 'http://localhost:8010';

export default function () {
  const loginPayload = JSON.stringify({
    email: 'admin@atlas.io',
    password: 'ChangeMe123!',
  });
  const loginRes = http.post(`${AUTH_URL}/login`, loginPayload, {
    headers: { 'Content-Type': 'application/json' },
  });
  const token = loginRes.status === 200 ? loginRes.json('token') : null;
  check(token, { 'auth token obtained': (t) => t !== null });
  errorRate.add(token ? 0 : 1);

  if (!token) {
    sleep(1);
    return;
  }

  const params = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'default',
    },
  };

  const payrollListRes = http.get(`${BASE_URL}/api/payroll`, params);
  const payListOk = check(payrollListRes, {
    'GET /payroll list responds': (r) => r.status === 200 || r.status === 403,
  });
  errorRate.add(!payListOk);

  const payrollRunPayload = JSON.stringify({
    employeeId: 'admin@atlas.io',
    period: new Date().toISOString().slice(0, 7),
    baseSalary: 120000,
    allowances: 5000,
    deductions: 2000,
  });

  const payrollRunRes = http.post(`${BASE_URL}/api/payroll/run`, payrollRunPayload, params);
  const payRunOk = check(payrollRunRes, {
    'POST /payroll/run responds': (r) =>
      r.status === 200 || r.status === 201 || r.status === 400 || r.status === 403,
  });
  payrollRunDuration.add(payrollRunRes.timings.duration);
  errorRate.add(!payRunOk);

  sleep(0.5);
}
