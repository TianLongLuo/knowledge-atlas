"use client";

import { useState, useEffect, useCallback } from "react";
import { getSyncStatus, getSyncHistory, startSync, SyncStatus, SyncHistoryItem } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, CheckCircle, AlertCircle, Clock, Zap } from "lucide-react";

export default function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([getSyncStatus(), getSyncHistory()]);
      setStatus(s);
      setHistory(h);
    } catch {
      // Silently fail — status will update on next SSE event
    }
  }, []);

  useEffect(() => {
    void refresh();

    // Listen for SSE sync events
    const onSyncStart = () => { setSyncing(true); void refresh(); };
    const onSyncComplete = () => { setSyncing(false); void refresh(); };
    const onSyncFailure = () => { setSyncing(false); void refresh(); };

    window.addEventListener("atlas:sync-start", onSyncStart);
    window.addEventListener("atlas:sync-complete", onSyncComplete);
    window.addEventListener("atlas:sync-failure", onSyncFailure);

    const interval = setInterval(refresh, 30000);
    return () => {
      clearInterval(interval);
      window.removeEventListener("atlas:sync-start", onSyncStart);
      window.removeEventListener("atlas:sync-complete", onSyncComplete);
      window.removeEventListener("atlas:sync-failure", onSyncFailure);
    };
  }, [refresh]);

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await startSync();
      await refresh();
    } catch {
      setSyncing(false);
    }
  };

  const statusIcon = status?.status === "syncing" || syncing
    ? <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
    : status?.status === "error"
    ? <AlertCircle className="h-4 w-4 text-red-500" />
    : <CheckCircle className="h-4 w-4 text-emerald-500" />;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sync</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Notion syncs automatically every 5 minutes via SSE real-time updates. Manual sync is available for immediate recovery.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            {statusIcon}
            Live status
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] gap-1">
              <Zap className="h-3 w-3" />Auto
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={handleManualSync}
              disabled={syncing}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={status?.status === "error" ? "destructive" : status?.status === "syncing" || syncing ? "default" : "secondary"}>
              {syncing ? "Syncing" : status?.status === "error" ? "Error" : status?.status === "syncing" ? "Syncing" : "Idle"}
            </Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last sync</span>
            <span>{status?.last_sync_time ? new Date(status.last_sync_time).toLocaleString("en-US") : "Never"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total synced</span>
            <span>{status?.total_synced ?? 0}</span>
          </div>
          {status?.errors ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Errors</span>
              <span className="text-red-500">{status.errors}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Sync history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No sync history yet</p>
          ) : (
            <div className="space-y-2">
              {history.slice(0, 10).map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded-lg border p-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    {item.status === "completed" ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500" /> :
                     item.status === "failed" ? <AlertCircle className="h-3.5 w-3.5 text-red-500" /> :
                     <RefreshCw className="h-3.5 w-3.5 text-blue-500 animate-spin" />}
                    <span className="text-xs text-muted-foreground">
                      {new Date(item.started_at).toLocaleString("en-US")}
                    </span>
                  </div>
                  <Badge variant={item.status === "completed" ? "secondary" : item.status === "failed" ? "destructive" : "outline"}>
                    {item.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
