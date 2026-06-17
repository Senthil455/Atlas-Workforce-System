import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const loginDuration = new Trend('login_duration');
const employeesDuration = new Trend('employees_duration');
const payrollDuration = new Trend('payroll_duration');

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.01'],
    login_duration: ['p(95)<2000'],
    employees_duration: ['p(95)<1000'],
    payroll_duration: ['p(95)<1000'],
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
  loginDuration.add(loginRes.timings.duration);
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

  const empRes = http.get(`${BASE_URL}/api/employee/employees?page=1&page_size=10`, params);
  const empOk = check(empRes, {
    'GET /employees returns 200': (r) => r.status === 200,
  });
  employeesDuration.add(empRes.timings.duration);
  errorRate.add(!empOk);

  const payrollRes = http.get(`${BASE_URL}/api/payroll`, params);
  const payOk = check(payrollRes, {
    'GET /payroll returns 200 or 403': (r) => r.status === 200 || r.status === 403,
  });
  payrollDuration.add(payrollRes.timings.duration);
  errorRate.add(!payOk);

  sleep(1);
}
