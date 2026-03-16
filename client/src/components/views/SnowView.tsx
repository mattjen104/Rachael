import React, { useState } from "react";
import { useSnowQueue, useBridgeStatus } from "@/hooks/use-org-data";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface SnowRecord {
  number: string;
  shortDescription: string;
  state: string;
  priority: string;
  assignedTo: string;
  assignmentGroup: string;
  updatedOn: string;
  type: "incident" | "change" | "request";
  slaBreached: boolean;
  url?: string;
}

type TabKey = "queue" | "team" | "sla";

export default function SnowView() {
  const [activeTab, setActiveTab] = useState<TabKey>("queue");
  const { data: snowData, isLoading, refetch } = useSnowQueue();
  const { data: bridgeStatus } = useBridgeStatus();
  const bridgeConnected = bridgeStatus?.extension?.connected || false;

  const myQueue: SnowRecord[] = snowData?.myQueue || [];
  const teamWorkload: Array<{ group: string; count: number }> = snowData?.teamWorkload || [];
  const agingRisk: SnowRecord[] = snowData?.agingRisk || [];
  const fetchedAt = snowData?.fetchedAt;
  const cacheAge = fetchedAt ? Math.round((Date.now() - fetchedAt) / 1000) : null;

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "queue", label: "My Queue", count: myQueue.length },
    { key: "team", label: "Team Workload", count: teamWorkload.length },
    { key: "sla", label: "Aging/SLA Risk", count: agingRisk.length },
  ];

  const typeIcon = (type: string) => {
    if (type === "incident") return "INC";
    if (type === "change") return "CHG";
    return "REQ";
  };

  const priorityColor = (p: string) => {
    if (/1|Critical/i.test(p)) return "text-red-400";
    if (/2|High/i.test(p)) return "text-orange-400";
    if (/3|Moderate/i.test(p)) return "text-yellow-400";
    return "text-muted-foreground";
  };

  if (!bridgeConnected) {
    return (
      <div className="flex flex-col h-full font-mono text-xs" data-testid="snow-view">
        <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between">
          <span>SNOW -- ServiceNow Command Center</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-4 text-center" data-testid="snow-disconnected">
          <div>
            <div className="mb-2">Chrome extension bridge not connected</div>
            <div className="text-[10px]">ServiceNow requires your authenticated browser session.</div>
            <div className="text-[10px] mt-1">Run: bridge-status</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full font-mono text-xs" data-testid="snow-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between items-center">
        <span>SNOW -- ServiceNow Command Center</span>
        <div className="flex items-center gap-2">
          {cacheAge !== null && <span className="text-[10px]">{cacheAge}s ago</span>}
          <button
            onClick={async () => {
              try {
                await apiRequest("POST", "/api/snow/refresh");
                queryClient.invalidateQueries({ queryKey: ["/api/snow/queue"] });
                queryClient.invalidateQueries({ queryKey: ["/api/snow/records"] });
                refetch();
              } catch { refetch(); }
            }}
            className="text-[10px] text-primary hover:underline cursor-pointer"
            data-testid="button-snow-refresh"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex border-b border-border">
        {tabs.map(tab => (
          <button
            key={tab.key}
            data-testid={`button-snow-tab-${tab.key}`}
            className={`flex-1 px-2 py-1 text-center cursor-pointer select-none transition-colors ${
              activeTab === tab.key
                ? "text-primary bg-primary/10 font-bold border-b-2 border-primary"
                : "text-muted-foreground hover:text-primary"
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label} {tab.count > 0 ? `(${tab.count})` : ""}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-4 text-muted-foreground text-center" data-testid="snow-loading">Loading ServiceNow data...</div>
        )}

        {!isLoading && activeTab === "queue" && (
          <div className="p-1" data-testid="snow-my-queue">
            {myQueue.length === 0 ? (
              <div className="p-4 text-muted-foreground text-center">
                <div>No items in your queue</div>
                <div className="text-[10px] mt-1">Run: snow refresh to fetch data</div>
              </div>
            ) : (
              myQueue.map((r, i) => (
                <div
                  key={`${r.number}-${i}`}
                  data-testid={`snow-record-${r.number}`}
                  className="px-2 py-1 border-b border-border/50 hover:bg-primary/5 cursor-pointer"
                  onClick={() => r.url && window.open(r.url, "_blank")}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground w-6 shrink-0">{typeIcon(r.type)}</span>
                    <span className="text-primary shrink-0">{r.number}</span>
                    <span className={`shrink-0 text-[10px] ${priorityColor(r.priority)}`}>{r.priority || ""}</span>
                    {r.slaBreached && <span className="text-red-400 text-[10px]">SLA</span>}
                  </div>
                  <div className="pl-8 truncate">{r.shortDescription}</div>
                  <div className="pl-8 text-[10px] text-muted-foreground">
                    {r.state} {r.assignmentGroup ? `| ${r.assignmentGroup}` : ""}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {!isLoading && activeTab === "team" && (
          <div className="p-1" data-testid="snow-team-workload">
            {teamWorkload.length === 0 ? (
              <div className="p-4 text-muted-foreground text-center">
                <div>No team data available</div>
                <div className="text-[10px] mt-1">Run: snow queue to fetch group data</div>
              </div>
            ) : (
              teamWorkload.map((g, i) => (
                <div key={`${g.group}-${i}`} className="px-2 py-1 border-b border-border/50" data-testid={`snow-group-${i}`}>
                  <div className="flex justify-between items-center">
                    <span className="truncate flex-1">{g.group}</span>
                    <span className="text-primary font-bold ml-2">{g.count}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {!isLoading && activeTab === "sla" && (
          <div className="p-1" data-testid="snow-aging-risk">
            {agingRisk.length === 0 ? (
              <div className="p-4 text-muted-foreground text-center">
                <div>No SLA risk items detected</div>
                <div className="text-[10px] mt-1">Items approaching or past SLA will appear here</div>
              </div>
            ) : (
              agingRisk.map((r, i) => (
                <div
                  key={`${r.number}-${i}`}
                  data-testid={`snow-sla-${r.number}`}
                  className="px-2 py-1 border-b border-border/50 hover:bg-primary/5 cursor-pointer"
                  onClick={() => r.url && window.open(r.url, "_blank")}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-red-400 text-[10px]">SLA</span>
                    <span className="text-primary shrink-0">{r.number}</span>
                    <span className={`shrink-0 text-[10px] ${priorityColor(r.priority)}`}>{r.priority || ""}</span>
                  </div>
                  <div className="pl-8 truncate">{r.shortDescription}</div>
                  <div className="pl-8 text-[10px] text-muted-foreground">{r.state}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="px-2 py-1 border-t border-border text-[10px] text-muted-foreground flex justify-between">
        <span>:snow refresh | :snow incidents | :snow detail NUM</span>
        <span>Click record to open in SNOW</span>
      </div>
    </div>
  );
}
