"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { search, SearchResultItem } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, FileText, ArrowRight, Loader2 } from "lucide-react";

export default function SearchPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [searchType, setSearchType] = useState<"keyword" | "vector" | "hybrid">("hybrid");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const data = await search({ query: query.trim(), search_type: searchType });
      setResults(data.results);
      setTotal(data.total);
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setLoading(false);
    }
  }, [query, searchType]);

  useEffect(() => {
    const q = searchParams.get("q");
    if (q) {
      setQuery(q);
      doSearch();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch();
  };

  const formatScore = (score: number) => {
    return (score * 100).toFixed(1) + "%";
  };

  const sourceLabel = (t: string) => {
    const labels: Record<string, string> = {
      file: "文件", url: "网址", manual: "手动", api: "API",
    };
    return labels[t] || t;
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">知识搜索</h1>
        <p className="text-muted-foreground mt-1">
          在知识库中搜索相关内容
        </p>
      </div>

      {/* Search form */}
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="输入搜索关键词..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={searchType}
              onValueChange={(v) => setSearchType(v as typeof searchType)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hybrid">混合搜索</SelectItem>
                <SelectItem value="keyword">关键词</SelectItem>
                <SelectItem value="vector">语义搜索</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "搜索"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Results */}
      {searched && (
        <Card>
          <CardHeader>
            <CardTitle>
              搜索结果
              <span className="text-sm text-muted-foreground font-normal ml-2">
                {loading ? "搜索中..." : `共 ${total} 条结果`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : results.length === 0 ? (
              <div className="text-center py-8">
                <Search className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground">未找到相关结果</p>
                <p className="text-sm text-muted-foreground mt-1">
                  尝试使用不同的关键词或搜索类型
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {results.map((item, idx) => (
                  <div
                    key={item.chunk_id || idx}
                    className="p-4 rounded-lg border hover:bg-accent/50 cursor-pointer transition-colors"
                    onClick={() =>
                      router.push(`/documents/${item.document_id}`)
                    }
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="font-medium text-sm truncate">
                            {item.document_title || "未知文档"}
                          </span>
                          <Badge variant="outline" className="text-xs shrink-0">
                            {sourceLabel(item.source_type)}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-3 mt-1">
                          {item.content}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge variant="secondary" className="text-xs">
                          相似度 {formatScore(item.score)}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground mt-2 ml-auto" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
