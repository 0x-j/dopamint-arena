import { useState } from "react";
import { useSuiClientContext } from "@mysten/dapp-kit";
import { Link } from "@tanstack/react-router";

import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { list } from "@/games/registry";
import { suivisionAccountUrl, suivisionTxUrl } from "@/lib/suivision";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { TxnRow } from "./types";
import { HashLink } from "./atoms";

/**
 * Tabbed transaction table shared by the on-chain and local feeds. An "All" tab
 * plus one tab per game filters by game id. With `onchain`, each row shows
 * DIGEST + ADDRESS (SuiVision) + PROOF (our explorer); without it (local activity
 * not yet settled), those three are dropped. The viewer's own rows are accented (`mine`).
 */
export function TransactionsFeed({
  title,
  rows: allRows,
  onchain = false,
  className,
}: {
  title: string;
  rows: TxnRow[];
  onchain?: boolean;
  className?: string;
}) {
  const [tab, setTab] = useState("all");
  const { network } = useSuiClientContext();
  const rows = tab === "all" ? allRows : allRows.filter((t) => t.game === tab);
  // On "All", rows span every game — show a GAME column so each is identifiable. On a
  // per-game tab it's redundant (the tab already names the game), so it's hidden.
  const showGame = tab === "all";
  const gameNames = new Map(list().map((g) => [g.id, g.name]));
  const colCount = (onchain ? 5 : 2) + (showGame ? 1 : 0);
  // One reference instant for every row's relative label; the ~1/s SSE re-render keeps it fresh.
  const now = Date.now();

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-1.5">
          <TabsTrigger value="all" className="shrink-0 text-[11px]">
            All
          </TabsTrigger>
          {list().map((g) => (
            <TabsTrigger
              key={g.id}
              value={g.id}
              className="shrink-0 text-[11px]"
            >
              {g.name}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                {onchain && (
                  <>
                    <th className="px-2.5 py-1.5 font-medium">DIGEST</th>
                    <th className="px-2.5 py-1.5 font-medium">ADDRESS</th>
                    <th className="px-2.5 py-1.5 font-medium">PROOF</th>
                  </>
                )}
                {showGame && (
                  <th className="px-2.5 py-1.5 font-medium">GAME</th>
                )}
                <th className="px-2.5 py-1.5 font-medium">TIME</th>
                <th className="px-2.5 py-1.5 font-medium">TYPE</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={colCount}
                    className="px-2.5 py-8 text-center text-muted-foreground"
                  >
                    No activity yet.
                  </td>
                </tr>
              ) : (
                rows.map((t) => (
                  <tr
                    key={t.id}
                    className={
                      "border-t border-border/60 border-l-2 " +
                      (t.mine
                        ? "border-l-primary bg-primary/10"
                        : "border-l-transparent")
                    }
                  >
                    {onchain && (
                      <>
                        <td className="px-2.5 py-1.5">
                          {t.digest ? (
                            <HashLink
                              value={t.digest}
                              href={suivisionTxUrl(t.digest, network)}
                              label="digest"
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5">
                          {t.address ? (
                            <HashLink
                              value={t.address}
                              href={suivisionAccountUrl(t.address, network)}
                              label="address"
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5">
                          {t.type === "Settled" && t.digest ? (
                            <Link
                              to="/explorer/$digest"
                              params={{ digest: t.digest }}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-[11px] text-foreground/80 transition-colors hover:text-primary hover:underline"
                            >
                              Verify ↗
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </>
                    )}
                    {showGame && (
                      <td className="px-2.5 py-1.5 text-foreground">
                        {gameNames.get(t.game) ?? t.game}
                      </td>
                    )}
                    <td
                      className="px-2.5 py-1.5 text-muted-foreground"
                      title={t.time}
                    >
                      {t.timestampMs != null
                        ? formatRelativeTime(t.timestampMs, now)
                        : t.time}
                    </td>
                    <td className="px-2.5 py-1.5">{t.type}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Tabs>
    </Panel>
  );
}
