"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getSyncStatus,
  getSyncHistory,
  startSync,
  SyncStatus,
  SyncHistoryItem,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  Play,
  History,
} from "lucide-react";

export default function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncLoading, setSyncLoading] = useState(false);
  const [message, setMessage] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [statusData, historyData] = await Promise.all([
        getSyncStatus(),
        getSyncHistory(),
      ]);
      setStatus(statusData);
      setHistory(historyData);
    } catch (err) {
      console.error("Failed to load sync data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Poll status every 10 seconds if sync is in progress
    const interval = setInterval(() => {
      getSyncStatus().then((s) => setStatus(s)).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleStartSync = async () => {
    setSyncLoading(true);
    setMessage("");
    try {
      const result = await startSync();
      setMessage(result.message || "Sync started");
      // Refresh status
      const newStatus = await getSyncStatus();
      setStatus(newStatus);
      const newHistory = await getSyncHistory();
      setHistory(newHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start sync";
      setMessage(msg);
    } finally {
      setSyncLoading(false);
    }
  };

  const statusBadge = (s: string) => {
    switch (s) {
      case "idle":
        return (
          <Badge variant="secondary">
            <CheckCircle className="h-3 w-3 mr-1" />
            Idle
          </Badge>
        );
      case "syncing":
        return (
          <Badge>
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            Syncing
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            Error
          </Badge>
        );
      default:
        return <Badge variant="outline">{s}</Badge>;
    }
  };

  const syncHistoryStatusBadge = (s: string) => {
    switch (s) {
      case "completed":
        return (
          <Badge variant="secondary" className="text-xs">
            <CheckCircle className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive" className="text-xs">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        );
      case "in_progress":
        return (
          <Badge className="text-xs">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            In progress
          </Badge>
        );
      default:
        return <Badge variant="outline" className="text-xs">{s}</Badge>;
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Data Sync</h1>
        <p className="text-muted-foreground mt-1">
          Manage and monitor knowledge-base synchronization.
        </p>
      </div>

      {/* Sync status & action */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Sync status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Current status</p>
                  <div className="mt-1">{statusBadge(status?.status || "idle")}</div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last sync</p>
                  <p className="text-sm font-medium mt-1">
                    {status?.last_sync_time
                      ? new Date(status.last_sync_time).toLocaleString("en-US")
                      : "Never"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Synced documents</p>
                  <p className="text-sm font-medium mt-1">
                    {status?.total_synced ?? 0}
                  </p>
                </div>
                {status?.errors !== undefined && status.errors > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Errors</p>
                    <p className="text-sm font-medium mt-1 text-destructive">
                      {status.errors}
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Sync action</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              className="w-full"
              onClick={handleStartSync}
              disabled={syncLoading || status?.sync_in_progress}
            >
              {syncLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Start sync
                </>
              )}
            </Button>

            {status?.sync_in_progress && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Sync in progress...
              </div>
            )}

            {message && (
              <div className="text-sm p-2 rounded bg-accent/50">{message}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sync history */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Sync history
          </CardTitle>
          <CardDescription>Recent sync records</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-4">
              No sync records yet
            </p>
          ) : (
            <ScrollArea className="h-[400px]">
              <div className="space-y-2">
                {history.map((item, idx) => (
                  <div key={item.id || idx}>
                    {idx > 0 && <Separator className="my-2" />}
                    <div className="flex items-center justify-between p-2">
                      <div className="flex items-center gap-3">
                        {syncHistoryStatusBadge(item.status)}
                        <div>
                          <p className="text-sm">
                            Processed{" "}
                            <span className="font-medium">
                              {item.documents_processed}
                            </span>{" "}
                            documents
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(item.started_at).toLocaleString("en-US")}
                            {item.completed_at &&
                              ` · completed at ${new Date(item.completed_at).toLocaleString("en-US")}`}
                          </p>
                        </div>
                      </div>
                      {item.errors > 0 && (
                        <div className="flex items-center gap-1 text-destructive text-sm">
                          <AlertCircle className="h-4 w-4" />
                          {item.errors} errors
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
