"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi } from "@/lib/api";
import { toast } from "@/stores/toast-store";

const schema = z
  .object({
    token: z.string().min(1, "Reset token required"),
    password: z
      .string()
      .min(8, "At least 8 characters")
      .regex(/[A-Z]/, "Include uppercase")
      .regex(/[0-9]/, "Include a number"),
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormData = z.infer<typeof schema>;

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  useEffect(() => {
    const token = searchParams.get("token");
    if (token) {
      setValue("token", token);
    }
  }, [searchParams, setValue]);

  const onSubmit = async (data: FormData) => {
    setIsLoading(true);
    try {
      await authApi.resetPassword(data.token.trim(), data.password);
      toast({
        title: "Password updated",
        description: "Sign in with your new password.",
      });
      router.push("/login");
    } catch {
      toast({
        title: "Reset failed",
        description: "This link is invalid or expired. Request a new one.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="border-white/10 bg-white/5 text-white shadow-2xl backdrop-blur-xl">
      <CardHeader>
        <CardTitle className="text-2xl">Set a new password</CardTitle>
        <CardDescription className="text-slate-300">
          Paste the token from your reset email or open the emailed link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="token" className="text-slate-200">
              Reset token
            </Label>
            <Input
              id="token"
              type="text"
              placeholder="Token from email"
              className="border-white/20 bg-white/10 text-white placeholder:text-slate-400"
              {...register("token")}
            />
            {errors.token && (
              <p className="text-sm text-red-400">{errors.token.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-slate-200">
              New password
            </Label>
            <Input
              id="password"
              type="password"
              className="border-white/20 bg-white/10 text-white"
              {...register("password")}
            />
            {errors.password && (
              <p className="text-sm text-red-400">{errors.password.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword" className="text-slate-200">
              Confirm password
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              className="border-white/20 bg-white/10 text-white"
              {...register("confirmPassword")}
            />
            {errors.confirmPassword && (
              <p className="text-sm text-red-400">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Updating..." : "Reset password"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-400">
          <Link href="/forgot-password" className="text-indigo-300 hover:underline">
            Request a new link
          </Link>{" "}
          ·{" "}
          <Link href="/login" className="text-indigo-300 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-300">Loading...</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
