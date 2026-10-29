import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import type { Column } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, LoadingState } from '../../components/States.js';
import type { ComputerUseToolInfo } from '../../../core/types.js';

export interface ToolsCardProps {
  tools: readonly ComputerUseToolInfo[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function policyBadges(tool: ComputerUseToolInfo) {
  const badges = [];
  if (tool.highPrivilege) badges.push(<Badge key="high" tone="danger">high privilege</Badge>);
  if (tool.approvalRequired) badges.push(<Badge key="approval" tone="warning">approval required</Badge>);
  if (tool.readOnly) badges.push(<Badge key="readonly" tone="info">read-only</Badge>);
  if (badges.length === 0) badges.push(<Badge key="standard" tone="neutral">standard</Badge>);
  return <span className="flex flex-wrap gap-1">{badges}</span>;
}

/** Read-only view of the tools the managed computer-use server advertises. */
export function ToolsCard({ tools, loading, error, onRetry }: ToolsCardProps) {
  if (loading) {
    return (
      <Card title="Computer tools" subtitle="Tools the managed computer-use server exposes to agents">
        <LoadingState label="Loading tools…" />
      </Card>
    );
  }
  if (error !== null) {
    return (
      <Card title="Computer tools" subtitle="Tools the managed computer-use server exposes to agents">
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const columns: ReadonlyArray<Column<ComputerUseToolInfo>> = [
    {
      key: 'name',
      header: 'Tool',
      render: (tool) => <span className="font-mono text-[11px] text-slate-200">{tool.name}</span>,
      headerClassName: 'w-56',
    },
    {
      key: 'description',
      header: 'Description',
      render: (tool) => (
        <span className="text-xs leading-relaxed text-slate-400">{tool.description || '—'}</span>
      ),
    },
    {
      key: 'policy',
      header: 'Access',
      render: (tool) => policyBadges(tool),
      headerClassName: 'w-48',
    },
  ];

  return (
    <Card
      title="Computer tools"
      subtitle={`${tools.length} tool${tools.length === 1 ? '' : 's'} exposed by the managed computer-use server`}
      padded={false}
    >
      <Table
        columns={columns}
        rows={tools}
        getRowKey={(tool) => tool.name}
        empty={
          <EmptyState
            icon="⌘"
            title="No tools advertised"
            description="The managed computer-use server has not advertised any tools yet. Configure the broker and use Sync broker to refresh its tool list."
          />
        }
      />
    </Card>
  );
}
