"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  getDashboardStats,
  getRecentDocuments,
  DashboardStats,
  RecentDocument,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText,
  Grid3X3,
  Clock,
  Activity,
  Search,
  ArrowRight,
} from "lucide-react";

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentDocs, setRecentDocs] = useState<RecentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();

  useEffect(() => {
    async function loadData() {
      try {
        const [statsData, recentData] = await Promise.all([
          getDashboardStats(),
          getRecentDocuments(),
        ]);
        setStats(statsData);
        setRecentDocs(recentData);
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "idle":
        return "Idle";
      case "syncing":
        return "Syncing";
      case "error":
        return "Error";
      default:
        return status;
    }
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "idle":
        return "secondary" as const;
      case "syncing":
        return "default" as const;
      case "error":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  const formatTime = (t: string | null) => {
    if (!t) return "Never";
    return new Date(t).toLocaleString("en-US");
  };

  const sourceTypeLabel = (t: string) => {
    const labels: Record<string, string> = {
      file: "File",
      url: "URL",
      manual: "Manual",
      api: "API",
    };
    return labels[t] || t;
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Overview of your knowledge base.
        </p>
      </div>

      {/* Quick search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Quick search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>

      {/* Stats cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          <>
            {[...Array(4)].map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-20" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Documents
                </CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.total_documents ?? 0}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Knowledge chunks
                </CardTitle>
                <Grid3X3 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.total_chunks ?? 0}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Last sync
                </CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-sm font-medium">
                  {formatTime(stats?.last_sync_time ?? null)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Sync status
                </CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <Badge variant={statusVariant(stats?.sync_status ?? "idle")}>
                  {statusLabel(stats?.sync_status ?? "idle")}
                </Badge>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Recent documents */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent documents</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/documents")}
          >
            View all
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : recentDocs.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-4">
              No documents yet
            </p>
          ) : (
            <div className="space-y-2">
              {recentDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => router.push(`/documents/${doc.id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{doc.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {sourceTypeLabel(doc.source_type)} ·{" "}
                        {new Date(doc.created_at).toLocaleString("en-US")}
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
