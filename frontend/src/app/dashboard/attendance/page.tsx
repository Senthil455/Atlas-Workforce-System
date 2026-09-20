"use client";


import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToastStore } from "@/stores/toast-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  Clock, Clock9, Download, FileSpreadsheet, MapPin, QrCode, Smartphone,
  Camera, Fingerprint, Shield, AlertTriangle, Home, BarChart3,
  BrainCircuit, Calendar, Users, ChevronDown, ChevronUp, Plus,
  Trash2, Check, X, Globe, Radio,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { downloadExcel } from "@/lib/excel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  AttendanceRecordV2, GeoFence, GeoVerifyResult, Shift, EmployeeShift,
  Roster, QRAttendance, NFCRegistration, BiometricDevice, FaceEnrollment,
  AnomalyLog, WFHTracking, HeatmapData, LateArrivalPrediction,
  AttendanceAIInsight, AttendanceDashboardSummary, AttendanceAIChatMessage,
} from "@/types";

const statusVariant: Record<string, "default" | "secondary" | "success" | "warning" | "destructive"> = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "destructive",
  REMOTE: "secondary",
  WFH: "default",
};

const severityVariant: Record<string, "default" | "secondary" | "warning" | "destructive"> = {
  low: "secondary",
  medium: "warning",
  high: "destructive",
};

const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
};

// ============================================================
// Records Tab
// ============================================================
function RecordsTab() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.toast);
  const [clockingIn, setClockingIn] = useState(false);
  const [clockingOut, setClockingOut] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [geoStatus, setGeoStatus] = useState<GeoVerifyResult | null>(null);

  const { data: records, isLoading } = useQuery({
    queryKey: ["attendance"],
    queryFn: async () => {
      const { data } = await attendanceApi.list();
      return (Array.isArray(data) ? data : []) as AttendanceRecordV2[];
    },
  });

  const { data: dashboard } = useQuery({
    queryKey: ["attendance-dashboard"],
    queryFn: async () => {
      const { data } = await attendanceApi.dashboard();
      return data as AttendanceDashboardSummary;
    },
  });

  // Use auth store directly - persisted under "atlas-auth" (not "auth-storage")
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.email ?? "";

  const getGPS = useCallback(async () => {
    if (!navigator.geolocation) return null;
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 })
      );
      return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch { return null; }
  }, []);

  const verifyGPS = async () => {
    setGpsLoading(true);
    try {
      const coords = await getGPS();
      if (!coords) { addToast({ title: "GPS unavailable", variant: "destructive" }); return; }
      const { data } = await attendanceApi.geoFences.verify(coords.latitude, coords.longitude);
      setGeoStatus(data as GeoVerifyResult);
      addToast({ title: data.verified ? "Inside geo-fence" : "Outside geo-fence", variant: data.verified ? "default" : "destructive" });
    } finally { setGpsLoading(false); }
  };

  const handleClockIn = async () => {
    if (!employeeId) { addToast({ title: "Employee ID not found", variant: "destructive" }); return; }
    setClockingIn(true);
    try {
      const coords = await getGPS();
      const method = coords ? "gps" : "manual";
      await attendanceApi.clockIn(employeeId, undefined, {
        latitude: coords?.latitude, longitude: coords?.longitude, method,
        ipAddress: "", userAgent: navigator.userAgent,
      });
      addToast({ title: "Clocked in successfully", description: `Method: ${method}` });
      void queryClient.invalidateQueries({ queryKey: ["attendance"] });
      void queryClient.invalidateQueries({ queryKey: ["attendance-dashboard"] });
    } catch { addToast({ title: "Failed to clock in", variant: "destructive" }); }
    finally { setClockingIn(false); }
  };

  const handleClockOut = async () => {
    if (!employeeId) { addToast({ title: "Employee ID not found", variant: "destructive" }); return; }
    setClockingOut(true);
    try {
      const coords = await getGPS();
      await attendanceApi.clockOut(employeeId, undefined, {
        latitude: coords?.latitude, longitude: coords?.longitude, method: coords ? "gps" : "manual",
      });
      addToast({ title: "Clocked out successfully" });
      void queryClient.invalidateQueries({ queryKey: ["attendance"] });
      void queryClient.invalidateQueries({ queryKey: ["attendance-dashboard"] });
    } catch { addToast({ title: "Failed to clock out", variant: "destructive" }); }
    finally { setClockingOut(false); }
  };

  return (
    <div className="space-y-4">
      {/* Dashboard KPIs */}
      {dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">Present</p><p className="text-xl font-bold text-green-600">{dashboard.presentToday}</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">Late</p><p className="text-xl font-bold text-yellow-600">{dashboard.lateToday}</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">Absent</p><p className="text-xl font-bold text-red-600">{dashboard.absentToday}</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">WFH</p><p className="text-xl font-bold text-blue-600">{dashboard.wfhToday}</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">Remote</p><p className="text-xl font-bold text-purple-600">{dashboard.remoteToday}</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">Avg OT</p><p className="text-xl font-bold">{dashboard.avgOvertime.toFixed(1)}h</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xs text-muted-foreground">Anomalies</p><p className="text-xl font-bold text-destructive">{dashboard.anomaliesCount}</p></CardContent></Card>
        </div>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Attendance</h1>
          <p className="text-muted-foreground">Daily check-in and check-out records</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={verifyGPS} disabled={gpsLoading}>
            <MapPin className="h-4 w-4" />
            {gpsLoading ? "Verifying..." : geoStatus?.verified ? "Verified" : "Verify GPS"}
          </Button>
          {geoStatus && (
            <Badge variant={geoStatus.verified ? "success" : "warning"}>
              {geoStatus.verified ? "In Zone" : `Outside (${geoStatus.distance.toFixed(0)}m)`}
            </Badge>
          )}
          <Button onClick={handleClockIn} disabled={clockingIn}>
            <Clock9 className="h-4 w-4" />
            {clockingIn ? "Clocking in..." : "Clock In"}
          </Button>
          <Button variant="outline" onClick={handleClockOut} disabled={clockingOut}>
            <Clock className="h-4 w-4" />
            {clockingOut ? "Clocking out..." : "Clock Out"}
          </Button>
        </div>
      </div>

      <Card className="glass-panel">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Attendance Records</CardTitle>
              <CardDescription>{isLoading ? "Loading..." : `${records?.length ?? 0} records`}</CardDescription>
            </div>
            {records && records.length > 0 && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => {
                  downloadCSV("attendance_records", ["Employee ID", "Date", "Clock In", "Clock Out", "Overtime", "Status", "Method", "Geo"], records.map((r) => [r.employeeId, formatDate(r.date), formatTime(r.clockIn), r.clockOut ? formatTime(r.clockOut) : "-", r.overtime > 0 ? `${r.overtime.toFixed(1)}h` : "-", r.status, r.method || "-", r.geoVerified ? "Yes" : "No"]));
                  addToast({ title: "Attendance data exported" });
                }}><Download className="h-4 w-4" /> CSV</Button>
                <Button variant="outline" size="sm" onClick={() => {
                  downloadExcel("attendance_records", ["Employee ID", "Date", "Clock In", "Clock Out", "Overtime", "Status", "Method", "Geo"], records.map((r) => [r.employeeId, formatDate(r.date), formatTime(r.clockIn), r.clockOut ? formatTime(r.clockOut) : "-", r.overtime > 0 ? `${r.overtime.toFixed(1)}h` : "-", r.status, r.method || "-", r.geoVerified ? "Yes" : "No"]));
                  addToast({ title: "Attendance data exported as Excel" });
                }}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className="px-4 py-3 font-medium">Employee</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Clock In</th>
                  <th className="px-4 py-3 font-medium">Clock Out</th>
                  <th className="px-4 py-3 font-medium">OT</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Method</th>
                  <th className="px-4 py-3 font-medium">Geo</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b"><td className="px-4 py-3" colSpan={8}><Skeleton className="h-5 w-full" /></td></tr>
                )) : !records || records.length === 0 ? (
                  <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={8}>No attendance records found.</td></tr>
                ) : records.map((row) => (
                  <tr key={row.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{row.employeeId}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(row.date)}</td>
                    <td className="px-4 py-3">{formatTime(row.clockIn)}</td>
                    <td className="px-4 py-3">{row.clockOut ? formatTime(row.clockOut) : "—"}</td>
                    <td className="px-4 py-3">{row.overtime > 0 ? `${row.overtime.toFixed(1)}h` : "—"}</td>
                    <td className="px-4 py-3"><Badge variant={statusVariant[row.status] ?? "default"}>{row.status}</Badge></td>
                    <td className="px-4 py-3"><Badge variant="secondary">{row.method || "manual"}</Badge></td>
                    <td className="px-4 py-3">{row.geoVerified ? <Check className="h-4 w-4 text-green-500" /> : row.latitude ? <X className="h-4 w-4 text-red-400" /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Geo-Fence Tab
// ============================================================
function GeoFenceTab() {
  const addToast = useToastStore((s) => s.toast);
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GeoFence | null>(null);
  const [name, setName] = useState(""); const [lat, setLat] = useState(""); const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("100"); const [address, setAddress] = useState("");

  const { data: fences } = useQuery({
    queryKey: ["geo-fences"],
    queryFn: async () => { const { data } = await attendanceApi.geoFences.list(); return (Array.isArray(data) ? data : []) as GeoFence[]; },
  });

  const resetForm = () => { setName(""); setLat(""); setLng(""); setRadius("100"); setAddress(""); setEditing(null); };

  const handleSave = async () => {
    try {
      if (editing) {
        await attendanceApi.geoFences.update(editing.id, { name, latitude: parseFloat(lat), longitude: parseFloat(lng), radiusMeters: parseFloat(radius), address });
        addToast({ title: "Geo-fence updated" });
      } else {
        await attendanceApi.geoFences.create({ name, latitude: parseFloat(lat), longitude: parseFloat(lng), radiusMeters: parseFloat(radius), address, isActive: true });
        addToast({ title: "Geo-fence created" });
      }
      resetForm(); setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["geo-fences"] });
    } catch { addToast({ title: "Failed to save geo-fence", variant: "destructive" }); }
  };

  const handleDelete = async (id: number) => {
    try { await attendanceApi.geoFences.delete(id); addToast({ title: "Geo-fence deleted" }); void queryClient.invalidateQueries({ queryKey: ["geo-fences"] }); }
    catch { addToast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const getCurrentLocation = () => {
    navigator.geolocation.getCurrentPosition((pos) => {
      setLat(pos.coords.latitude.toFixed(6)); setLng(pos.coords.longitude.toFixed(6));
    }, () => addToast({ title: "GPS unavailable", variant: "destructive" }));
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div><h2 className="text-lg font-semibold">Geo-Fence Zones</h2><p className="text-sm text-muted-foreground">Configure GPS-based attendance zones</p></div>
        <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) resetForm(); setDialogOpen(o); }}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4" /> Add Zone</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? "Edit" : "New"} Geo-Fence</DialogTitle><DialogDescription>Define an attendance zone with GPS coordinates</DialogDescription></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Office HQ" /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Latitude</Label><Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="12.9716" /></div>
                <div><Label>Longitude</Label><Input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="77.5946" /></div>
              </div>
              <Button variant="outline" size="sm" onClick={getCurrentLocation}><MapPin className="h-4 w-4" /> Use My Location</Button>
              <div><Label>Radius (meters)</Label><Input value={radius} onChange={(e) => setRadius(e.target.value)} placeholder="100" type="number" /></div>
              <div><Label>Address</Label><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" /></div>
              <Button onClick={handleSave} className="w-full">{editing ? "Update" : "Create"} Geo-Fence</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {(!fences || fences.length === 0) ? (
          <Card className="md:col-span-2 lg:col-span-3"><CardContent className="p-6 text-center text-muted-foreground">No geo-fences configured. Add one to enable GPS verification.</CardContent></Card>
        ) : fences.map((f) => (
          <Card key={f.id}>
            <CardContent className="p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-semibold">{f.name}</h3>
                  <p className="text-xs text-muted-foreground">{f.address || "No address"}</p>
                </div>
                <Badge variant={f.isActive ? "success" : "secondary"}>{f.isActive ? "Active" : "Inactive"}</Badge>
              </div>
              <div className="mt-2 text-xs space-y-1">
                <p><span className="text-muted-foreground">Lat:</span> {f.latitude.toFixed(4)}, <span className="text-muted-foreground">Lng:</span> {f.longitude.toFixed(4)}</p>
                <p><span className="text-muted-foreground">Radius:</span> {f.radiusMeters}m</p>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => { setEditing(f); setName(f.name); setLat(String(f.latitude)); setLng(String(f.longitude)); setRadius(String(f.radiusMeters)); setAddress(f.address); setDialogOpen(true); }}>Edit</Button>
                <Button variant="destructive" size="sm" onClick={() => handleDelete(f.id)}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Shifts & Rostering Tab
// ============================================================
function ShiftsTab() {
  const addToast = useToastStore((s) => s.toast);
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [shiftName, setShiftName] = useState(""); const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00"); const [grace, setGrace] = useState("15"); const [maxOT, setMaxOT] = useState("4");
  const [isNight, setIsNight] = useState(false); const [days, setDays] = useState("1,2,3,4,5");

  const { data: shifts } = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => { const { data } = await attendanceApi.shifts.list(); return (Array.isArray(data) ? data : []) as Shift[]; },
  });

  const { data: rosters } = useQuery({
    queryKey: ["rosters"],
    queryFn: async () => { const { data } = await attendanceApi.rosters.list(); return (Array.isArray(data) ? data : []) as Roster[]; },
  });

  const handleCreateShift = async () => {
    try {
      await attendanceApi.shifts.create({ name: shiftName, startTime, endTime, graceMinutes: parseInt(grace), maxOvertime: parseFloat(maxOT), isNightShift: isNight, daysOfWeek: days, isActive: true });
      addToast({ title: "Shift created" }); setDialogOpen(false); void queryClient.invalidateQueries({ queryKey: ["shifts"] });
    } catch { addToast({ title: "Failed to create shift", variant: "destructive" }); }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div><h2 className="text-lg font-semibold">Shift Scheduling</h2><p className="text-sm text-muted-foreground">Define shifts and manage rosters</p></div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4" /> New Shift</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create Shift</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Shift Name</Label><Input value={shiftName} onChange={(e) => setShiftName(e.target.value)} placeholder="Morning Shift" /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Start Time</Label><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
                <div><Label>End Time</Label><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Grace (min)</Label><Input type="number" value={grace} onChange={(e) => setGrace(e.target.value)} /></div>
                <div><Label>Max OT (hrs)</Label><Input type="number" value={maxOT} onChange={(e) => setMaxOT(e.target.value)} /></div>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isNight} onChange={(e) => setIsNight(e.target.checked)} /> Night Shift</label>
              <div><Label>Days of Week (1=Mon)</Label><Input value={days} onChange={(e) => setDays(e.target.value)} placeholder="1,2,3,4,5" /></div>
              <Button onClick={handleCreateShift} className="w-full">Create Shift</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {(!shifts || shifts.length === 0) ? (
          <Card><CardContent className="p-4 text-center text-muted-foreground">No shifts defined</CardContent></Card>
        ) : shifts.map((s) => (
          <Card key={s.id}><CardContent className="p-4">
            <div className="flex justify-between"><h3 className="font-semibold">{s.name}</h3><Badge variant={s.isActive ? "success" : "secondary"}>{s.isActive ? "Active" : "Inactive"}</Badge></div>
            <p className="text-sm mt-1">{s.startTime} - {s.endTime} | Grace: {s.graceMinutes}min | Max OT: {s.maxOvertime}h</p>
            <p className="text-xs text-muted-foreground">{s.isNightShift ? "Night Shift" : "Day Shift"} | Days: {s.daysOfWeek}</p>
          </CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Dynamic Rosters</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/50 text-left"><th className="px-4 py-3 font-medium">Employee</th><th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Shift</th><th className="px-4 py-3 font-medium">Published</th></tr></thead>
              <tbody>
                {(!rosters || rosters.length === 0) ? (
                  <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={4}>No rosters assigned</td></tr>
                ) : rosters.map((r) => (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{r.employeeId}</td>
                    <td className="px-4 py-3">{formatDate(r.date)}</td>
                    <td className="px-4 py-3">{r.shift?.name || `Shift #${r.shiftId}`}</td>
                    <td className="px-4 py-3">{r.isPublished ? <Badge variant="success">Published</Badge> : <Badge variant="secondary">Draft</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// QR & NFC Tab
// ============================================================
function QRNfcTab() {
  const addToast = useToastStore((s) => s.toast);
  const queryClient = useQueryClient();
  const [qrToken, setQrToken] = useState<QRAttendance | null>(null);
  const [nfcUid, setNfcUid] = useState(""); const [nfcEmployee, setNfcEmployee] = useState(""); const [nfcDevice, setNfcDevice] = useState("");
  const [nfcDialog, setNfcDialog] = useState(false);

  const { data: nfcDevices } = useQuery({
    queryKey: ["nfc-list"],
    queryFn: async () => { const { data } = await attendanceApi.nfc.list(); return (Array.isArray(data) ? data : []) as NFCRegistration[]; },
  });

  const generateQR = async () => {
    try { const { data } = await attendanceApi.qr.generate(); setQrToken(data as QRAttendance); addToast({ title: "QR token generated" }); }
    catch { addToast({ title: "Failed to generate QR", variant: "destructive" }); }
  };

  const registerNFC = async () => {
    try { await attendanceApi.nfc.register({ employeeId: nfcEmployee, nfcUid: nfcUid, deviceName: nfcDevice, isActive: true } as Partial<NFCRegistration>); addToast({ title: "NFC card registered" }); setNfcDialog(false); void queryClient.invalidateQueries({ queryKey: ["nfc-list"] }); }
    catch { addToast({ title: "Failed to register NFC", variant: "destructive" }); }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        {/* QR Attendance */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><QrCode className="h-4 w-4" /> QR Attendance</CardTitle><CardDescription>Generate QR codes for contactless check-in</CardDescription></CardHeader>
          <CardContent>
            <Button onClick={generateQR} className="w-full mb-3"><QrCode className="h-4 w-4" /> Generate QR Token</Button>
            {qrToken && (
              <div className="p-3 bg-muted rounded-lg text-center">
                <p className="font-mono text-sm break-all">{qrToken.token}</p>
                <p className="text-xs text-muted-foreground mt-1">Expires: {new Date(qrToken.expiresAt).toLocaleTimeString()}</p>
                <p className="text-xs text-muted-foreground">Status: {qrToken.isUsed ? "Used" : "Active"}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* NFC Attendance */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Smartphone className="h-4 w-4" /> NFC Attendance</CardTitle><CardDescription>Register NFC cards for tap-to-clock</CardDescription></CardHeader>
          <CardContent>
            <Dialog open={nfcDialog} onOpenChange={setNfcDialog}>
              <DialogTrigger asChild><Button className="w-full mb-3"><Radio className="h-4 w-4" /> Register NFC Card</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Register NFC Card</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div><Label>Employee ID</Label><Input value={nfcEmployee} onChange={(e) => setNfcEmployee(e.target.value)} placeholder="emp@email.com" /></div>
                  <div><Label>NFC UID</Label><Input value={nfcUid} onChange={(e) => setNfcUid(e.target.value)} placeholder="04:AB:CD:EF" /></div>
                  <div><Label>Device Name</Label><Input value={nfcDevice} onChange={(e) => setNfcDevice(e.target.value)} placeholder="Office Entry Card" /></div>
                  <Button onClick={registerNFC} className="w-full">Register</Button>
                </div>
              </DialogContent>
            </Dialog>

            <div className="space-y-2">
              {(!nfcDevices || nfcDevices.length === 0) ? (
                <p className="text-sm text-muted-foreground text-center">No NFC cards registered</p>
              ) : nfcDevices.map((n) => (
                <div key={n.id} className="p-2 bg-muted rounded text-sm flex justify-between items-center">
                  <div><span className="font-medium">{n.deviceName}</span><br /><span className="text-xs text-muted-foreground">{n.employeeId} — {n.nfcUid}</span></div>
                  <Badge variant={n.isActive ? "success" : "secondary"}>{n.isActive ? "Active" : "Inactive"}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// Face & Biometric Tab
// ============================================================
function FaceBiometricTab() {
  const addToast = useToastStore((s) => s.toast);
  const queryClient = useQueryClient();
  const [empId, setEmpId] = useState(""); const [imageUrl, setImageUrl] = useState("");
  const [bEmpId, setBEmpId] = useState(""); const [bType, setBType] = useState("fingerprint"); const [bUid, setBUid] = useState(""); const [bHash, setBHash] = useState("");

  const { data: devices } = useQuery({
    queryKey: ["biometric-devices"],
    queryFn: async () => { const { data } = await attendanceApi.biometric.devices(); return (Array.isArray(data) ? data : []) as BiometricDevice[]; },
  });

  const enrollFace = async () => {
    try { await attendanceApi.face.enroll(empId, imageUrl); addToast({ title: "Face enrolled" }); }
    catch { addToast({ title: "Failed to enroll face", variant: "destructive" }); }
  };

  const registerBio = async () => {
    try { await attendanceApi.biometric.register({ employeeId: bEmpId, deviceType: bType, deviceUid: bUid, hash: bHash, isActive: true } as Partial<BiometricDevice>); addToast({ title: "Biometric registered" }); void queryClient.invalidateQueries({ queryKey: ["biometric-devices"] }); }
    catch { addToast({ title: "Failed to register", variant: "destructive" }); }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        {/* Face Recognition */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Camera className="h-4 w-4" /> Face Recognition</CardTitle><CardDescription>Enroll employee face data for face-based clock-in</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>Employee ID</Label><Input value={empId} onChange={(e) => setEmpId(e.target.value)} placeholder="emp@email.com" /></div>
            <div><Label>Image URL</Label><Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." /></div>
            <Button onClick={enrollFace} className="w-full"><Camera className="h-4 w-4" /> Enroll Face</Button>
          </CardContent>
        </Card>

        {/* Biometric */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Fingerprint className="h-4 w-4" /> Biometric Integration</CardTitle><CardDescription>Register fingerprint / device biometrics</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>Employee ID</Label><Input value={bEmpId} onChange={(e) => setBEmpId(e.target.value)} placeholder="emp@email.com" /></div>
            <div><Label>Device Type</Label><Input value={bType} onChange={(e) => setBType(e.target.value)} placeholder="fingerprint" /></div>
            <div><Label>Device UID</Label><Input value={bUid} onChange={(e) => setBUid(e.target.value)} placeholder="device-001" /></div>
            <div><Label>Hash</Label><Input value={bHash} onChange={(e) => setBHash(e.target.value)} placeholder="biometric hash" /></div>
            <Button onClick={registerBio} className="w-full"><Fingerprint className="h-4 w-4" /> Register Biometric</Button>
          </CardContent>
        </Card>
      </div>

      {/* Registered Biometric Devices */}
      {devices && devices.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Registered Biometric Devices</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {devices.map((d) => (
                <div key={d.id} className="flex justify-between items-center p-2 bg-muted rounded text-sm">
                  <div><span className="font-medium">{d.deviceType}</span> — <span className="text-muted-foreground">{d.employeeId}</span><br /><span className="text-xs text-muted-foreground">UID: {d.deviceUid}</span></div>
                  <Badge variant={d.isActive ? "success" : "secondary"}>{d.isActive ? "Active" : "Inactive"}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// Anomalies Tab
// ============================================================
function AnomaliesTab() {
  const addToast = useToastStore((s) => s.toast);
  const queryClient = useQueryClient();

  const { data: anomalies } = useQuery({
    queryKey: ["anomalies"],
    queryFn: async () => { const { data } = await attendanceApi.anomalies.list(); return (Array.isArray(data) ? data : []) as AnomalyLog[]; },
  });

  const handleResolve = async (id: number) => {
    try { await attendanceApi.anomalies.resolve(id); addToast({ title: "Anomaly resolved" }); void queryClient.invalidateQueries({ queryKey: ["anomalies"] }); }
    catch { addToast({ title: "Failed to resolve", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div><h2 className="text-lg font-semibold">Anomaly Detection</h2><p className="text-sm text-muted-foreground">Attendance irregularities flagged by the system</p></div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/50 text-left"><th className="px-4 py-3 font-medium">Employee</th><th className="px-4 py-3 font-medium">Type</th><th className="px-4 py-3 font-medium">Severity</th><th className="px-4 py-3 font-medium">Description</th><th className="px-4 py-3 font-medium">Detected</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Action</th></tr></thead>
              <tbody>
                {(!anomalies || anomalies.length === 0) ? (
                  <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>No anomalies detected</td></tr>
                ) : anomalies.map((a) => (
                  <tr key={a.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{a.employeeId}</td>
                    <td className="px-4 py-3"><Badge variant="secondary">{a.anomalyType}</Badge></td>
                    <td className="px-4 py-3"><Badge variant={severityVariant[a.severity] ?? "default"}>{a.severity}</Badge></td>
                    <td className="px-4 py-3 max-w-xs truncate">{a.description}</td>
                    <td className="px-4 py-3 text-xs">{new Date(a.detectedAt).toLocaleString()}</td>
                    <td className="px-4 py-3">{a.isResolved ? <Badge variant="success">Resolved</Badge> : <Badge variant="warning">Open</Badge>}</td>
                    <td className="px-4 py-3">{!a.isResolved && <Button size="sm" variant="outline" onClick={() => handleResolve(a.id)}><Check className="h-3 w-3" /> Resolve</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// WFH / Hybrid Tab
// ============================================================
function WFHTab() {
  const addToast = useToastStore((s) => s.toast);
  const queryClient = useQueryClient();
  const [empId, setEmpId] = useState(""); const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [isWfh, setIsWfh] = useState(true); const [isRemote, setIsRemote] = useState(false);
  const [location, setLocation] = useState(""); const [notes, setNotes] = useState("");

  const { data: entries } = useQuery({
    queryKey: ["wfh-entries"],
    queryFn: async () => { const { data } = await attendanceApi.wfh.list(); return (Array.isArray(data) ? data : []) as WFHTracking[]; },
  });

  const handleCreate = async () => {
    try { await attendanceApi.wfh.create({ employeeId: empId, date, isWfh, isRemote, location, notes } as Partial<WFHTracking>); addToast({ title: "WFH entry created" }); void queryClient.invalidateQueries({ queryKey: ["wfh-entries"] }); }
    catch { addToast({ title: "Failed to create", variant: "destructive" }); }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Home className="h-4 w-4" /> Log WFH / Remote</CardTitle><CardDescription>Track work-from-home and remote work</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>Employee ID</Label><Input value={empId} onChange={(e) => setEmpId(e.target.value)} placeholder="emp@email.com" /></div>
            <div><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isWfh} onChange={(e) => setIsWfh(e.target.checked)} /> WFH</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isRemote} onChange={(e) => setIsRemote(e.target.checked)} /> Remote</label>
            </div>
            <div><Label>Location</Label><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Home office" /></div>
            <div><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" /></div>
            <Button onClick={handleCreate} className="w-full"><Home className="h-4 w-4" /> Log Entry</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Hybrid Workforce</CardTitle><CardDescription>Recent WFH and remote work entries</CardDescription></CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {(!entries || entries.length === 0) ? (
                <p className="text-sm text-muted-foreground text-center">No entries yet</p>
              ) : entries.slice(0, 20).map((e) => (
                <div key={e.id} className="p-2 bg-muted rounded text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium">{e.employeeId}</span>
                    <Badge variant={e.isWfh ? "default" : "secondary"}>{e.isWfh ? "WFH" : e.isRemote ? "Remote" : "Office"}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{formatDate(e.date)}{e.location ? ` — ${e.location}` : ""}</p>
                  {e.notes && <p className="text-xs mt-1">{e.notes}</p>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// Heatmap Tab
// ============================================================
function HeatmapTab() {
  const [period, setPeriod] = useState("month");

  const { data: heatmap } = useQuery({
    queryKey: ["heatmap", period],
    queryFn: async () => { const { data } = await attendanceApi.heatmap(period); return data as HeatmapData; },
  });

  const getColor = (count: number, total: number) => {
    if (total === 0) return "bg-muted";
    const ratio = count / total;
    if (ratio >= 0.9) return "bg-green-500";
    if (ratio >= 0.7) return "bg-green-400";
    if (ratio >= 0.5) return "bg-yellow-400";
    if (ratio >= 0.3) return "bg-orange-400";
    return "bg-red-400";
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div><h2 className="text-lg font-semibold">Attendance Heatmap</h2><p className="text-sm text-muted-foreground">Visual attendance patterns over time</p></div>
        <div className="flex gap-2">
          {["week", "month", "quarter"].map((p) => (
            <Button key={p} size="sm" variant={period === p ? "default" : "outline"} onClick={() => setPeriod(p)}>{p.charAt(0).toUpperCase() + p.slice(1)}</Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          {(!heatmap?.data || heatmap.data.length === 0) ? (
            <p className="text-center text-muted-foreground py-8">No heatmap data available for this period</p>
          ) : (
            <div className="grid grid-cols-7 gap-2">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="text-center text-xs font-medium text-muted-foreground p-1">{d}</div>
              ))}
              {heatmap.data.map((day) => {
                const d = new Date(day.date);
                const dayOfWeek = d.getDay();
                const presentCount = day.statuses["PRESENT"] || 0;
                const lateCount = day.statuses["LATE"] || 0;
                const absentCount = day.statuses["ABSENT"] || 0;
                const total = day.total || 1;
                return (
                  <div key={day.date} className="text-center" style={{ gridColumnStart: heatmap.data.indexOf(day) === 0 ? dayOfWeek + 1 : undefined }}>
                    <div className={`${getColor(presentCount, total)} rounded p-1 text-xs text-white`} title={`${day.date}: ${presentCount} present, ${lateCount} late, ${absentCount} absent`}>
                      <span className="font-medium">{new Date(day.date).getDate()}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">{presentCount}/{total}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-3 mt-4 justify-center text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-400 inline-block" /> High</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-400 inline-block" /> Medium</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-400 inline-block" /> Low</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-400 inline-block" /> Poor</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Predictions & AI Tab
// ============================================================
function PredictionsAITab() {
  const addToast = useToastStore((s) => s.toast);
  const [predEmpId, setPredEmpId] = useState("");
  const [prediction, setPrediction] = useState<LateArrivalPrediction | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsg, setChatMsg] = useState("");
  const [chatHistory, setChatHistory] = useState<AttendanceAIChatMessage[]>([]);

  const { data: insights } = useQuery({
    queryKey: ["ai-insights"],
    queryFn: async () => { const { data } = await attendanceApi.aiInsights(); return (Array.isArray(data?.insights) ? data.insights : []) as AttendanceAIInsight[]; },
  });

  const handlePredict = async () => {
    if (!predEmpId) { addToast({ title: "Enter employee ID", variant: "destructive" }); return; }
    setPredicting(true);
    try { const { data } = await attendanceApi.predictLateArrival(predEmpId); setPrediction(data as LateArrivalPrediction); }
    catch { addToast({ title: "Prediction failed", variant: "destructive" }); }
    finally { setPredicting(false); }
  };

  const handleChat = async () => {
    if (!chatMsg.trim()) return;
    const userMsg: AttendanceAIChatMessage = { id: Date.now().toString(), role: "user", content: chatMsg, timestamp: new Date().toISOString() };
    setChatHistory((prev) => [...prev, userMsg]);
    setChatMsg("");

    let reply = "";
    const lower = chatMsg.toLowerCase();
    if (lower.includes("late") || lower.includes("prediction")) {
      reply = "I can predict late arrivals. Go to the Late Arrival Prediction section and enter an employee ID to analyze their pattern.";
    } else if (lower.includes("overtime")) {
      reply = "The system detects overtime automatically when clock-out exceeds standard shift hours. Check the insights below for overtime analysis.";
    } else if (lower.includes("geo") || lower.includes("gps") || lower.includes("fence")) {
      reply = "Geo-fenced attendance uses GPS to verify you're at the right location. Admins can configure zones in the Geo-Fence tab.";
    } else if (lower.includes("qr")) {
      reply = "QR attendance lets you generate time-limited QR tokens for contactless check-in. See the QR & NFC tab.";
    } else if (lower.includes("nfc")) {
      reply = "NFC attendance allows tap-to-clock using registered NFC cards. Register cards in the QR & NFC tab.";
    } else if (lower.includes("face") || lower.includes("camera")) {
      reply = "Face recognition attendance uses facial verification for clock-in. Enroll faces in the Face & Biometric tab.";
    } else if (lower.includes("anomaly")) {
      reply = "The system automatically detects attendance anomalies like duplicate clock-ins, location changes, and frequent overtime. Check the Anomalies tab.";
    } else if (lower.includes("hybrid") || lower.includes("wfh") || lower.includes("remote")) {
      reply = "Hybrid workforce tracking logs WFH and remote days. Use the WFH/Hybrid tab to record entries.";
    } else if (lower.includes("heatmap")) {
      reply = "The attendance heatmap shows visual patterns of attendance over time. Check the Heatmap tab.";
    } else if (lower.includes("shift") || lower.includes("roster")) {
      reply = "Shift scheduling and dynamic rostering let you define shifts and assign them to employees. See the Shifts & Rostering tab.";
    } else {
      reply = "I can help with: attendance records, late arrival prediction, overtime tracking, geo-fence GPS verification, QR/NFC check-in, face recognition, biometrics, anomaly detection, WFH/remote tracking, heatmaps, shift scheduling, and more. What would you like to know?";
    }

    const assistantMsg: AttendanceAIChatMessage = { id: (Date.now() + 1).toString(), role: "assistant", content: reply, timestamp: new Date().toISOString() };
    setTimeout(() => setChatHistory((prev) => [...prev, assistantMsg]), 500);
  };

  return (
    <div className="space-y-6">
      {/* Late Arrival Prediction */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock9 className="h-4 w-4" /> Late Arrival Prediction</CardTitle><CardDescription>Predict late arrivals based on historical patterns</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={predEmpId} onChange={(e) => setPredEmpId(e.target.value)} placeholder="Employee ID" className="flex-1" />
            <Button onClick={handlePredict} disabled={predicting}>{predicting ? "Analyzing..." : "Predict"}</Button>
          </div>
          {prediction && (
            <div className="p-3 bg-muted rounded-lg space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-semibold">Prediction</span>
                <Badge variant={prediction.prediction ? "warning" : "success"}>{prediction.prediction ? "Likely Late" : "On Time"}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Confidence:</span> {prediction.confidence.toFixed(1)}%</div>
                <div><span className="text-muted-foreground">Late Rate:</span> {prediction.lateRate.toFixed(1)}%</div>
                <div><span className="text-muted-foreground">Avg Clock-In:</span> {prediction.avgClockIn}</div>
                <div><span className="text-muted-foreground">Days Analyzed:</span> {prediction.totalDays}</div>
              </div>
              {prediction.reason && <p className="text-sm text-muted-foreground">{prediction.reason}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI Insights */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><BarChart3 className="h-4 w-4" /> AI Insights</CardTitle><CardDescription>Automated attendance analytics</CardDescription></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {(!insights || insights.length === 0) ? (
              <p className="text-sm text-muted-foreground">No insights available yet</p>
            ) : insights.map((insight, i) => (
              <div key={i} className="p-3 bg-muted rounded-lg text-sm">
                <div className="flex justify-between items-center">
                  <span className="font-medium capitalize">{insight.type.replace(/_/g, " ")}</span>
                  {insight.severity && <Badge variant={severityVariant[insight.severity] ?? "default"}>{insight.severity}</Badge>}
                </div>
                <p className="text-muted-foreground mt-1">{insight.description}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* AI Chat Assistant */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <div><CardTitle className="text-base flex items-center gap-2"><BrainCircuit className="h-4 w-4" /> Attendance AI Assistant</CardTitle><CardDescription>Ask questions about attendance features</CardDescription></div>
            <Button variant="outline" size="sm" onClick={() => { if (chatOpen) { setChatHistory([]); } setChatOpen(!chatOpen); }}>
              {chatOpen ? "Close" : "Open"} Chat
            </Button>
          </div>
        </CardHeader>
        {chatOpen && (
          <CardContent>
            <div className="h-64 overflow-y-auto space-y-3 mb-3 p-2 border rounded-lg">
              {chatHistory.length === 0 && (
                <p className="text-sm text-muted-foreground text-center p-4">Ask me anything about attendance features!</p>
              )}
              {chatHistory.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] p-2 rounded-lg text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                    {msg.content}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={chatMsg} onChange={(e) => setChatMsg(e.target.value)} placeholder="Ask about attendance..." onKeyDown={(e) => e.key === "Enter" && handleChat()} />
              <Button onClick={handleChat}>Send</Button>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function AttendancePage() {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="records" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="records"><Clock className="h-4 w-4" /> Records</TabsTrigger>
          <TabsTrigger value="geo"><MapPin className="h-4 w-4" /> Geo-Fence</TabsTrigger>
          <TabsTrigger value="shifts"><Calendar className="h-4 w-4" /> Shifts</TabsTrigger>
          <TabsTrigger value="qr-nfc"><QrCode className="h-4 w-4" /> QR & NFC</TabsTrigger>
          <TabsTrigger value="face-bio"><Camera className="h-4 w-4" /> Face & Bio</TabsTrigger>
          <TabsTrigger value="anomalies"><Shield className="h-4 w-4" /> Anomalies</TabsTrigger>
          <TabsTrigger value="wfh"><Home className="h-4 w-4" /> WFH</TabsTrigger>
          <TabsTrigger value="heatmap"><BarChart3 className="h-4 w-4" /> Heatmap</TabsTrigger>
          <TabsTrigger value="ai"><BrainCircuit className="h-4 w-4" /> AI</TabsTrigger>
        </TabsList>

        <TabsContent value="records"><RecordsTab /></TabsContent>
        <TabsContent value="geo"><GeoFenceTab /></TabsContent>
        <TabsContent value="shifts"><ShiftsTab /></TabsContent>
        <TabsContent value="qr-nfc"><QRNfcTab /></TabsContent>
        <TabsContent value="face-bio"><FaceBiometricTab /></TabsContent>
        <TabsContent value="anomalies"><AnomaliesTab /></TabsContent>
        <TabsContent value="wfh"><WFHTab /></TabsContent>
        <TabsContent value="heatmap"><HeatmapTab /></TabsContent>
        <TabsContent value="ai"><PredictionsAITab /></TabsContent>
      </Tabs>
    </div>
  );
}
