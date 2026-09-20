"use client";


import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { leaveApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToastStore } from "@/stores/toast-store";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Download, FileSpreadsheet, Plus } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { downloadExcel } from "@/lib/excel";

interface LeaveRecord {
  id: number;
  employeeId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  leaveType: string;
  reason?: string;
  status: string;
}

const statusVariant: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
};

export default function LeavePage() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.toast);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Use auth store directly - persisted under "atlas-auth" (not "auth-storage")
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.email ?? "";
  const [form, setForm] = useState({
    startDate: "",
    endDate: "",
    leaveType: "VACATION",
    reason: "",
  });

  const { data: requests, isLoading } = useQuery({
    queryKey: ["leave"],
    queryFn: async () => {
      const { data } = await leaveApi.list();
      return (Array.isArray(data) ? data : []) as LeaveRecord[];
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) {
      addToast({ title: "Employee ID not found", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await leaveApi.request({
        employeeId,
        startDate: form.startDate,
        endDate: form.endDate,
        leaveType: form.leaveType,
        reason: form.reason || undefined,
      });
      addToast({ title: "Leave request submitted" });
      setDialogOpen(false);
      setForm({ startDate: "", endDate: "", leaveType: "VACATION", reason: "" });
      void queryClient.invalidateQueries({ queryKey: ["leave"] });
    } catch {
      addToast({ title: "Failed to submit leave request", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusUpdate = async (id: number, status: string) => {
    try {
      await leaveApi.updateStatus(id, status);
      addToast({ title: `Leave request ${status.toLowerCase()}` });
      void queryClient.invalidateQueries({ queryKey: ["leave"] });
    } catch {
      addToast({ title: `Failed to ${status.toLowerCase()} request`, variant: "destructive" });
    }
  };

  const calcDays = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    return Math.max(1, Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Leave</h1>
          <p className="text-muted-foreground">Leave requests and approvals</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              Request Leave
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Request Leave</DialogTitle>
                <DialogDescription>Submit a new leave request</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="leaveType">Leave Type</Label>
                  <select
                    id="leaveType"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={form.leaveType}
                    onChange={(e) => setForm((f) => ({ ...f, leaveType: e.target.value }))}
                  >
                    <option value="VACATION">Vacation</option>
                    <option value="SICK">Sick Leave</option>
                    <option value="PERSONAL">Personal</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input id="startDate" type="date" required value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">End Date</Label>
                  <Input id="endDate" type="date" required value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reason">Reason (optional)</Label>
                  <Input id="reason" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={submitting}>{submitting ? "Submitting..." : "Submit"}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Leave Requests</CardTitle>
              <CardDescription>{isLoading ? "Loading..." : `${requests?.length ?? 0} requests`}</CardDescription>
            </div>
            {requests && requests.length > 0 && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => {
                  downloadCSV("leave_requests", ["Employee", "Type", "Start", "End", "Days", "Status"], requests.map((r) => [r.employeeId, r.leaveType, formatDate(r.startDate), formatDate(r.endDate), String(calcDays(r.startDate, r.endDate)), r.status]));
                  addToast({ title: "Leave data exported" });
                }}><Download className="h-4 w-4" /> CSV</Button>
                <Button variant="outline" size="sm" onClick={() => {
                  downloadExcel("leave_requests", ["Employee", "Type", "Start", "End", "Days", "Status"], requests.map((r) => [r.employeeId, r.leaveType, formatDate(r.startDate), formatDate(r.endDate), String(calcDays(r.startDate, r.endDate)), r.status]));
                  addToast({ title: "Leave data exported as Excel" });
                }}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Employee</TableHead><TableHead>Type</TableHead><TableHead>Start</TableHead><TableHead>End</TableHead><TableHead>Days</TableHead><TableHead>Reason</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}><TableCell colSpan={8}><Skeleton className="h-5 w-full" /></TableCell></TableRow>
              )) : !requests || requests.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No leave requests found</TableCell></TableRow>
              ) : requests.map((req) => (
                <TableRow key={req.id}>
                  <TableCell className="font-medium">{req.employeeId}</TableCell>
                  <TableCell>{req.leaveType}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(req.startDate)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(req.endDate)}</TableCell>
                  <TableCell>{calcDays(req.startDate, req.endDate)}</TableCell>
                  <TableCell className="max-w-[150px] truncate text-muted-foreground">{req.reason || "—"}</TableCell>
                  <TableCell><Badge variant={statusVariant[req.status] ?? "default"}>{req.status}</Badge></TableCell>
                  <TableCell>{req.status === "PENDING" && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleStatusUpdate(req.id, "APPROVED")}>Approve</Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={() => handleStatusUpdate(req.id, "REJECTED")}>Reject</Button>
                    </div>
                  )}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
