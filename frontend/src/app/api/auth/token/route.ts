import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { jwtVerify } from "jose";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("access_token")?.value;
  if (!token) {
    return NextResponse.json({ token: null });
  }
  const secret = process.env.JWT_SECRET;
  if (secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ["HS256"],
      });
      return NextResponse.json({ token });
    } catch {
      // invalid or expired - clear the cookie and return null
      const res = NextResponse.json({ token: null });
      res.cookies.delete("access_token");
      res.cookies.set("access_token", "", { maxAge: 0, path: "/" });
      return res;
    }
  }
  // without secret, at least check expiry via decode to avoid returning stale token
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
    );
    if (typeof payload.exp === "number" && Date.now() >= payload.exp * 1000) {
      const res = NextResponse.json({ token: null });
      res.cookies.delete("access_token");
      return res;
    }
  } catch {
    const res = NextResponse.json({ token: null });
    res.cookies.delete("access_token");
    return res;
  }
  return NextResponse.json({ token });
}
