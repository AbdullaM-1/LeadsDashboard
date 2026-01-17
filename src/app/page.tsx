"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Chart from "chart.js/auto";
import Papa from "papaparse";
import { supabase } from "@/utils/supabase/client";

// --- Types ---
interface Metrics {
  totalLeads: number;
  newLeads: number;
  qualifiedLeads: number;
  discardedLeads: number;
  pendingLeads: number;
  todayCount: number;
  conversionRate: number;
  growth: number;
  dailyVolume: { label: string; count: number }[];
}

// --- Components ---


function Header({ isUploading, setIsUploading }: { isUploading: boolean; setIsUploading: (v: boolean) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setIsUploading(true);
      console.log("File selected:", file.name);

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: async (results) => {
          if (!results.data || results.data.length === 0) {
            alert("No data found in CSV file. Please check the file format.");
            setIsUploading(false);
            return;
          }

          try {
            const response = await fetch("/api/leads/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(results.data),
            });

            const data = await response.json();
            if (data.success) {
              alert(`Import complete! Processed: ${data.processed}`);
              window.location.reload();
            } else {
              alert(`Import failed: ${data.error || "Unknown error"}`);
            }
          } catch (error) {
            console.error("Upload error:", error);
            alert("Error uploading leads.");
          } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        },
        error: (error) => {
          console.error("CSV Parse Error:", error);
          alert("Failed to parse CSV file.");
          setIsUploading(false);
        },
      });
    }
  };

  return (
    <header className="max-w-7xl mx-auto flex justify-between items-end mb-16 px-4 sm:px-0">
      <div>
        <div className="flex items-center gap-3 mb-3">
          <span className="px-2 py-0.5 bg-emerald-50 text-emerald-600 text-[10px] font-black uppercase tracking-widest rounded-md border border-emerald-100">
            Live System
          </span>
          <span className="text-slate-300 text-xs">/</span>
          <span className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">
            Integrated Financial
          </span>
        </div>
        <h1 className="text-5xl font-black tracking-tight text-slate-900 leading-tight">
          Integrated Financial <span className="font-extralight italic">OS</span>
        </h1>
      </div>
      <div className="flex gap-4">
        <a
          href="/dashboard"
          className="px-6 py-3 bg-indigo-600 text-white rounded-2xl text-xs font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition flex items-center gap-2"
        >
          <i className="fa-solid fa-headset"></i> Open Dialer
        </a>
        <button className="px-6 py-3 bg-white border border-slate-200 rounded-2xl text-xs font-bold shadow-sm hover:bg-slate-50 transition">
          Export PDF
        </button>
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept=".csv"
          onChange={handleFileChange}
        />
        <button
          onClick={handleImportClick}
          disabled={isUploading}
          className={`px-6 py-3 bg-slate-900 text-white rounded-2xl text-xs font-bold shadow-lg shadow-slate-200 hover:scale-105 transition flex items-center gap-2 ${isUploading ? "opacity-75 cursor-wait" : ""
            }`}
        >
          {isUploading && <i className="fa-solid fa-circle-notch fa-spin"></i>}
          {isUploading ? "Importing..." : "Import Leads"}
        </button>
      </div>
    </header>
  );
}

function ExecutiveLeadIndex({ totalLeads, conversionRate, growth }: { totalLeads: number; conversionRate: number; growth: number }) {
  return (
    <div className="glass-panel lg:col-span-7 p-12 rounded-[3.5rem] relative overflow-hidden group">
      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 rounded-full blur-[100px] opacity-40 -mr-20 -mt-20"></div>
      <div className="relative z-10">
        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-[0.2em] mb-8">
          Executive Lead Index
        </h3>
        <div className="flex items-end gap-6">
          <span className="text-9xl font-black tracking-tighter text-slate-900">
            {totalLeads.toLocaleString()}
          </span>
          <div className="mb-4">
            <p className={`font-black text-xl ${growth >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
              {growth >= 0 ? '+' : ''}{growth}%
            </p>
            <p className="text-slate-400 text-[10px] font-bold uppercase">
              vs. Forecast
            </p>
          </div>
        </div>
        <div className="mt-12 grid grid-cols-3 gap-8 pt-10 border-t border-slate-100">
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase mb-1">
              Conversion
            </p>
            <p className="text-2xl font-bold">{conversionRate}%</p>
          </div>
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase mb-1">
              Velocity
            </p>
            <p className="text-2xl font-bold">High</p>
          </div>
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase mb-1">
              Market Cap
            </p>
            <p className="text-2xl font-bold">${(totalLeads * 560 / 1000000).toFixed(1)}M</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SecondaryBreakdown({ metrics }: { metrics: Metrics }) {
  return (
    <div className="lg:col-span-5 grid grid-cols-2 gap-6">
      {/* New Leads */}
      <div className="glass-panel p-8 rounded-[2.5rem] flex flex-col justify-between group overflow-hidden">
        <div className="flex justify-between items-center">
          <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center group-hover:bg-blue-600 group-hover:text-white transition-all">
            <i className="fa-solid fa-bolt"></i>
          </div>
          <span className="text-[10px] font-black text-blue-500">NEW</span>
        </div>
        <div>
          <h4 className="text-4xl font-black text-slate-900">{metrics.newLeads}</h4>
          <p className="text-xs text-slate-400 font-medium mt-1">
            {metrics.todayCount > 0 ? `+${metrics.todayCount} Incoming today` : 'No incoming today'}
          </p>
        </div>
      </div>
      {/* Qualified */}
      <div className="glass-panel p-8 rounded-[2.5rem] flex flex-col justify-between group">
        <div className="flex justify-between items-center">
          <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-all">
            <i className="fa-solid fa-certificate"></i>
          </div>
          <span className="text-[10px] font-black text-emerald-500">
            QUALIFIED
          </span>
        </div>
        <div>
          <h4 className="text-4xl font-black text-slate-900">{metrics.qualifiedLeads}</h4>
          <p className="text-xs text-slate-400 font-medium mt-1">
            Verified prospects
          </p>
        </div>
      </div>
      {/* Not Qualified */}
      <div className="glass-panel p-8 rounded-[2.5rem] flex flex-col justify-between group">
        <div className="flex justify-between items-center text-rose-500">
          <i className="fa-solid fa-circle-xmark text-xl"></i>
          <span className="text-[10px] font-black">DISCARDED</span>
        </div>
        <div>
          <h4 className="text-4xl font-black text-slate-900 opacity-30">
            {metrics.discardedLeads}
          </h4>
          <p className="text-xs text-slate-400 font-medium mt-1">
            Out of criteria
          </p>
        </div>
      </div>
      {/* Pending */}
      <div className="glass-panel p-8 rounded-[2.5rem] flex flex-col justify-between bg-slate-900 border-none group">
        <div className="flex justify-between items-center">
          <div className="w-10 h-10 bg-white/10 text-amber-400 rounded-xl flex items-center justify-center">
            <i className="fa-solid fa-phone-volume"></i>
          </div>
          <span className="text-[10px] font-black text-amber-400">
            PENDING
          </span>
        </div>
        <div>
          <h4 className="text-4xl font-black text-white tracking-tighter">
            {metrics.pendingLeads}
          </h4>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Needs action
          </p>
        </div>
      </div>
    </div>
  );
}

function VelocityMap({ data }: { data: { label: string; count: number }[] }) {
  const chartRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let chart: Chart | null = null;
    if (chartRef.current) {
      const ctx = chartRef.current.getContext("2d");
      if (ctx) {
        const mainGradient = ctx.createLinearGradient(0, 0, 0, 400);
        mainGradient.addColorStop(0, "rgba(99, 102, 241, 0.15)");
        mainGradient.addColorStop(1, "rgba(255, 255, 255, 0)");

        chart = new Chart(ctx, {
          type: "line",
          data: {
            labels: data.map(d => d.label),
            datasets: [
              {
                label: "Leads Received",
                data: data.map(d => d.count),
                borderColor: "#6366f1",
                borderWidth: 8,
                tension: 0.5,
                fill: true,
                backgroundColor: mainGradient,
                pointBackgroundColor: "#ffffff",
                pointBorderColor: "#6366f1",
                pointBorderWidth: 4,
                pointRadius: 0,
                pointHoverRadius: 12,
                pointHoverBorderWidth: 5,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: {
                beginAtZero: true,
                grid: { color: "rgba(0,0,0,0.03)", drawBorder: false } as any,
                ticks: {
                  color: "#94a3b8",
                  font: { weight: "600" as any },
                  padding: 10,
                },
              },
              x: {
                grid: { display: false },
                ticks: {
                  color: "#64748b",
                  font: { weight: "800" as any, size: 10 },
                  padding: 15,
                },
              },
            },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [data]);

  return (
    <div className="glass-panel lg:col-span-8 p-12 rounded-[3.5rem]">
      <div className="flex justify-between items-center mb-12">
        <div>
          <h3 className="text-2xl font-black text-slate-900 tracking-tight">
            Market Absorption
          </h3>
          <p className="text-sm text-slate-400 font-medium">
            Real-time Lead Intake Velocity (7-Day Period)
          </p>
        </div>
        <div className="flex bg-slate-100 p-1.5 rounded-2xl">
          <button className="px-5 py-2 text-[10px] font-black bg-white rounded-xl shadow-sm">
            VOLUME
          </button>
          <button className="px-5 py-2 text-[10px] font-black text-slate-400">
            QUALITY
          </button>
        </div>
      </div>
      <div className="h-[400px]">
        <canvas ref={chartRef}></canvas>
      </div>
    </div>
  );
}

function FunnelAnatomy({ metrics }: { metrics: Metrics }) {
  const chartRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let chart: Chart | null = null;
    if (chartRef.current) {
      const ctx = chartRef.current.getContext("2d");
      if (ctx) {
        chart = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels: ["Qualified", "New", "Trash", "Pending"],
            datasets: [
              {
                data: [metrics.qualifiedLeads, metrics.newLeads, metrics.discardedLeads, metrics.pendingLeads],
                backgroundColor: ["#6366f1", "#3b82f6", "#f1f5f9", "#f59e0b"],
                borderWidth: 0,
                borderRadius: 30,
                spacing: 12,
                hoverOffset: 30,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "82%",
            plugins: { legend: { display: false } },
            animation: {
              animateRotate: true,
              duration: 2500,
              easing: "easeOutQuart",
            },
          },
        });
      }
    }
    return () => chart?.destroy();
  }, [metrics]);

  return (
    <div className="glass-panel lg:col-span-4 p-12 rounded-[3.5rem] flex flex-col">
      <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-2">
        Funnel Anatomy
      </h3>
      <p className="text-sm text-slate-400 font-medium mb-10">
        Lifecycle distribution
      </p>

      <div className="relative flex-1 max-h-[300px]">
        <canvas ref={chartRef}></canvas>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <p className="text-5xl font-black text-slate-900 tracking-tighter">
            {((metrics.qualifiedLeads / (metrics.totalLeads || 1)) * 100).toFixed(1)}%
          </p>
          <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest">
            Integrity
          </p>
        </div>
      </div>

      <div className="mt-12 space-y-3">
        <div className="flex items-center justify-between p-5 bg-slate-50 rounded-[2rem] border border-slate-100">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
            Avg Response Time
          </span>
          <span className="text-sm font-black text-slate-900">2.1m</span>
        </div>
        <div className="flex items-center justify-between p-5 bg-indigo-600 rounded-[2rem] shadow-xl shadow-indigo-100">
          <span className="text-[10px] font-black text-indigo-100 uppercase tracking-widest">
            Conversion Rate
          </span>
          <span className="text-sm font-black text-white">{metrics.conversionRate}%</span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics>({
    totalLeads: 0,
    newLeads: 0,
    qualifiedLeads: 0,
    discardedLeads: 0,
    pendingLeads: 0,
    todayCount: 0,
    conversionRate: 0,
    growth: 0,
    dailyVolume: [],
  });
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    const fetchDashboardMetrics = async () => {
      try {
        // Fetch all leads for calculation
        const { data: leads, error } = await supabase.from("leads").select("status, created_at");
        if (error) throw error;

        const total = leads.length;
        const now = new Date();

        // Calculate daily volume for last 7 days
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const last7Days: { label: string; count: number }[] = [];

        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dayName = days[d.getDay()];
          const dateStr = d.toISOString().split('T')[0];

          const count = leads.filter(l => l.created_at.startsWith(dateStr)).length;
          last7Days.push({ label: i === 0 ? "Today" : dayName, count });
        }

        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();

        const todayLeads = leads.filter(l => l.created_at >= startOfToday);
        const yesterdayLeads = leads.filter(l => l.created_at >= startOfYesterday && l.created_at < startOfToday);

        const newCount = leads.filter(l => l.status === "New").length;
        const qualifiedCount = leads.filter(l => ["Qualified", "Qualified Lead"].includes(l.status)).length;
        const discardedCount = leads.filter(l => ["Not Interested", "Do Not Call", "W# (Wrong Number)"].includes(l.status)).length;
        const pendingCount = leads.filter(l => ["Call Back", "Voice Mail", "Left Voice Mail"].includes(l.status)).length;

        const conversion = total > 0 ? (qualifiedCount / total) * 100 : 0;

        // Growth calculation: today vs yesterday
        const growthValue = yesterdayLeads.length > 0
          ? ((todayLeads.length - yesterdayLeads.length) / yesterdayLeads.length) * 100
          : todayLeads.length > 0 ? 100 : 0;

        setMetrics({
          totalLeads: total,
          newLeads: newCount,
          qualifiedLeads: qualifiedCount,
          discardedLeads: discardedCount,
          pendingLeads: pendingCount,
          todayCount: todayLeads.length,
          conversionRate: Math.round(conversion * 10) / 10,
          growth: Math.round(growthValue * 10) / 10,
          dailyVolume: last7Days,
        });
      } catch (err) {
        console.error("Error fetching metrics:", err);
      }
    };

    fetchDashboardMetrics();
  }, []);

  return (
    <div className="antialiased text-slate-900 min-h-screen flex bg-[#FBFBFC]" style={{ fontFamily: "var(--font-geist-sans), 'Inter', sans-serif" }}>
      <div className="grain"></div>

      <main className="flex-1 p-8 lg:p-14 overflow-y-auto">
        <Header isUploading={isUploading} setIsUploading={setIsUploading} />

        <div className="max-w-7xl mx-auto">
          {/* Metrics Architecture (Nested Grid) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-12">
            <ExecutiveLeadIndex totalLeads={metrics.totalLeads} conversionRate={metrics.conversionRate} growth={metrics.growth} />
            <SecondaryBreakdown metrics={metrics} />
          </div>

          {/* Data Visualization */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <VelocityMap data={metrics.dailyVolume} />
            <FunnelAnatomy metrics={metrics} />
          </div>

        </div>
      </main>
    </div>
  );
}
