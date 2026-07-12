"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`space-y-4 text-[15px] leading-7 text-slate-700 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mt-7 text-2xl font-semibold tracking-tight text-slate-900 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-7 border-b border-slate-200/80 pb-2 text-xl font-semibold text-slate-900 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-6 text-base font-semibold text-slate-900 first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-2 pl-6 marker:text-blue-400">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-2 pl-6 marker:text-blue-500">{children}</ol>,
          li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
          blockquote: ({ children }) => <blockquote className="my-4 rounded-r-lg border-l-3 border-blue-300 bg-blue-50/60 px-4 py-2 text-slate-600">{children}</blockquote>,
          code: ({ children, className }) => className ? (
            <code className="block overflow-x-auto rounded-xl bg-slate-900 p-4 text-sm text-slate-100">{children}</code>
          ) : <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.9em] text-pink-700">{children}</code>,
          table: ({ children }) => <div className="my-4 overflow-x-auto rounded-xl border"><table className="w-full border-collapse text-sm">{children}</table></div>,
          th: ({ children }) => <th className="border-b bg-slate-50 px-3 py-2 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-3 hover:text-blue-700">{children}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
