import { Badge } from '../../components/Badge.js';
import { Card } from '../../components/Card.js';
import { Table } from '../../components/Table.js';
import type { Column } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { DangerButton } from '../../components/Form.js';
import { formatTimestamp } from '../../lib/format.js';
import type { ComputerUseEnrollmentInfo } from '../../../core/types.js';
import { enrollmentExpiryLabel, enrollmentKindLabel, lifetimeMinutes } from './shared.js';

export interface PendingPairingsSectionProps {
  enrollments: ComputerUseEnrollmentInfo[];
  loading: boolean;
  onRevoke: (enrollment: ComputerUseEnrollmentInfo) => void;
}

/**
 * Live (unclaimed) pairing tokens. The token itself is never listed — only the
 * kind and when it was created / expires — so the table stays safe to share.
 */
export function PendingPairingsSection({ enrollments, loading, onRevoke }: PendingPairingsSectionProps) {
  const columns: ReadonlyArray<Column<ComputerUseEnrollmentInfo>> = [
    {
      key: 'kind',
      header: 'Kind',
      render: (enrollment) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone="info">{enrollmentKindLabel(enrollment.kind)}</Badge>
          <span className="font-mono text-[10px] text-slate-600">{enrollment.id}</span>
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      render: (enrollment) =>
        enrollment.createdAt === null ? (
          <span className="text-slate-500">—</span>
        ) : (
          <span title={formatTimestamp(enrollment.createdAt)} className="text-xs">
            {formatTimestamp(enrollment.createdAt)}
          </span>
        ),
    },
    {
      key: 'expires',
      header: 'Expires',
      render: (enrollment) => {
        const lifetime = lifetimeMinutes(enrollment.createdAt, enrollment.expiresAt);
        return (
          <span className="flex flex-col">
            <span className="text-xs text-slate-200">
              {enrollmentExpiryLabel(enrollment)}
            </span>
            <span className="text-[10px] text-slate-500" title={formatTimestamp(enrollment.expiresAt)}>
              {formatTimestamp(enrollment.expiresAt)}
              {lifetime !== null ? ` · ${lifetime}m token` : ''}
            </span>
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      headerClassName: 'text-right',
      render: (enrollment) => (
        <DangerButton
          onClick={() => onRevoke(enrollment)}
          className="px-2.5 py-1 text-xs"
          aria-label={`Revoke pairing ${enrollment.id}`}
        >
          Revoke
        </DangerButton>
      ),
    },
  ];

  return (
    <Card
      title="Pending pairings"
      subtitle="Tokens waiting for a machine to claim them. They expire automatically; revoke one to invalidate it immediately."
      padded={enrollments.length === 0 && !loading ? false : true}
    >
      <Table
        columns={columns}
        rows={enrollments}
        getRowKey={(enrollment) => enrollment.id}
        loading={loading}
        empty={
          <EmptyState
            icon="⧗"
            title="No pending pairings"
            description="Use “Add Linux PC” to mint a single-use install command. It appears here until the machine connects or the token expires."
          />
        }
      />
    </Card>
  );
}
