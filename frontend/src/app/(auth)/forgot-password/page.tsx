"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi } from "@/lib/api";
import { toast } from "@/stores/toast-store";

const schema = z.object({
  email: z.string().email("Valid email required"),
});

type FormData = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormData) => {
    setIsLoading(true);
    try {
      await authApi.requestPasswordReset(data.email);
      setSent(true);
      toast({
        title: "Check your email",
        description: "If an account exists, a reset link has been sent.",
      });
    } catch {
      // Keep the response generic even on failure to avoid enumeration.
      setSent(true);
      toast({
        title: "Check your email",
        description: "If an account exists, a reset link has been sent.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="border-white/10 bg-white/5 text-white shadow-2xl backdrop-blur-xl">
      <CardHeader>
        <CardTitle className="text-2xl">Forgot password</CardTitle>
        <CardDescription className="text-slate-300">
          Enter your work email and we will send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              If an account exists for that email, a single-use reset link valid
              for 1 hour has been sent. Check your inbox and follow the link to
              set a new password.
            </p>
            <p className="text-center text-sm text-slate-400">
              <Link href="/login" className="text-indigo-300 hover:underline">
                Back to sign in
              </Link>
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-slate-200">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                className="border-white/20 bg-white/10 text-white placeholder:text-slate-400"
                {...register("email")}
              />
              {errors.email && (
                <p className="text-sm text-red-400">{errors.email.message}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "Sending..." : "Send reset link"}
            </Button>
          </form>
        )}
        {!sent && (
          <p className="mt-4 text-center text-sm text-slate-400">
            Remembered it?{" "}
            <Link href="/login" className="text-indigo-300 hover:underline">
              Sign in
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
