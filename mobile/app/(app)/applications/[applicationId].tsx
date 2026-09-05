import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { PATHS, fillPath, type ApplicationDetail } from '@/api/client';
import { describeError } from '@/api/errors';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, formatDateTime, humanise, statusLabel } from '@/lib/format';
import { Body, Button, Card, ErrorState, KeyValue, LoadingState, Muted, OfflineBanner, Pill, Row, Screen, Title } from '@/ui/components';

/**
 * The folder (GET /v1/applications/{applicationId}): every prepared field
 * and answer for review, the history, contacts, interviews, follow-ups,
 * documents (opened through a ten-minute signed link), and the two actions
 * the applicant can take - "I submitted this on the employer's form"
 * (confirm) and, in Review & submit mode on an authorised board, "submit it
 * for me now" (submit). Both are the applicant's own act; nothing here
 * happens on a timer or offline.
 */
export default function ApplicationScreen() {
  const { applicationId } = useLocalSearchParams<{ applicationId: string }>();
  const { client, me } = useSession();
  const id = applicationId ?? '';
  const path = fillPath(PATHS.application, { applicationId: id });
  const q = useQuery(path, () => client.application(id), undefined, Boolean(id));
  const [local, setLocal] = useState<ApplicationDetail | null>(null);
  const [busy, setBusy] = useState<'confirm' | 'submit' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a = local ?? q.data;

  const act = async (kind: 'confirm' | 'submit') => {
    if (!a) return;
    setBusy(kind);
    setError(null);
    try {
      const next = kind === 'confirm' ? await client.confirm(a.id) : await client.submit(a.id);
      setLocal(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const ask = (kind: 'confirm' | 'submit') => {
    const title = kind === 'confirm' ? 'Confirm you submitted this?' : 'Submit this application now?';
    const message =
      kind === 'confirm'
        ? 'This records that you sent the application on the employer’s form. JobPilot does not send anything.'
        : 'JobPilot will submit the application you reviewed through the employer’s authorised system, once, on your instruction. This cannot be undone.';
    if (Platform.OS === 'web') {
      if (typeof globalThis.confirm === 'function' && globalThis.confirm(`${title}\n\n${message}`)) void act(kind);
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: kind === 'confirm' ? 'Yes, I submitted it' : 'Submit now', style: kind === 'submit' ? 'destructive' : 'default', onPress: () => void act(kind) },
    ]);
  };

  const openDocument = async (documentId: string) => {
    if (!a) return;
    setBusy(documentId);
    setError(null);
    try {
      const link = await client.documentLink(a.id, documentId);
      await Linking.openURL(link.url);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  if (q.loading) return <Screen><LoadingState /></Screen>;
  if (!a) return <Screen><ErrorState error={q.error ?? new Error('Application not found.')} onRetry={q.refresh} /></Screen>;

  const ready = a.status === 'ready_to_submit';
  const offline = q.fromCache;
  const canInstruct = ready && a.atsSubmittable && me?.applicationMode === 'review_submit';
  const tone = a.status === 'submitted' || a.status === 'interviewing' || a.status === 'offer' ? 'success' : a.status === 'failed' ? 'danger' : ready ? 'warning' : 'neutral';

  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      {offline ? <OfflineBanner storedAt={q.storedAt} /> : null}
      <Title>{a.job.title}</Title>
      <Body>{a.job.company} · {a.job.location}</Body>
      <Row style={{ marginTop: 8 }}>
        <Pill tone={tone}>{statusLabel(a.status)}</Pill>
        <Pill>Match {Math.round(a.matchScore)}%</Pill>
        <Pill>ATS {Math.round(a.atsScore)}%</Pill>
        {a.outcome !== 'pending' ? <Pill>{humanise(a.outcome)}</Pill> : null}
      </Row>
      <Muted>Prepared {formatDate(a.createdAt)} in “{humanise(a.applicationMode)}” with field mappings {a.fieldMappingVersion}{a.appliedAt ? ` · sent ${formatDateTime(a.appliedAt)}` : ''}.</Muted>
      {a.failureReason ? <ErrorState error={new Error(a.failureReason)} /> : null}
      {error ? <ErrorState error={new Error(error)} /> : null}

      {ready ? (
        <Card>
          <Title level={3}>Your decision</Title>
          <Body>Review every field and answer below. Then either submit on the employer’s form yourself and confirm it here, {canInstruct ? 'or instruct JobPilot to submit it through the employer’s authorised system.' : 'which is the only path for this employer.'}</Body>
          <Button title="Open the employer’s form" variant="secondary" onPress={() => Linking.openURL(a.job.applyUrl)} />
          <Button title="I submitted it on the employer’s form" onPress={() => ask('confirm')} busy={busy === 'confirm'} disabled={offline || busy !== null} accessibilityHint="Records your submission; JobPilot sends nothing" />
          {canInstruct ? <Button title="Submit it for me now" onPress={() => ask('submit')} busy={busy === 'submit'} disabled={offline || busy !== null} accessibilityHint="Submits once through the employer's authorised system on your instruction" /> : null}
          {!canInstruct && a.atsSubmittable ? <Muted style={{ marginTop: 8 }}>Instructed submission needs the “Review & submit” mode (change it under You › Edit profile).</Muted> : null}
          {offline ? <Muted style={{ marginTop: 8 }}>Actions are disabled while offline; nothing is queued.</Muted> : null}
        </Card>
      ) : null}

      <Card>
        <Title level={3}>Prepared fields ({a.preparedFields.length})</Title>
        {a.preparedFields.length === 0 ? <Muted>No fields were prepared for this application.</Muted> : null}
        {a.preparedFields.map((f) => (
          <KeyValue key={f.key} label={f.label} value={f.multiline ? `${f.value.slice(0, 240)}${f.value.length > 240 ? '…' : ''}` : f.value} />
        ))}
      </Card>

      <Card>
        <Title level={3}>Questions ({a.preparedQuestions.length})</Title>
        {a.preparedQuestions.length === 0 ? <Muted>No application questions were prepared.</Muted> : null}
        {a.preparedQuestions.map((qn) => (
          <KeyValue key={qn.id} label={qn.question} value={qn.decision === 'never' ? 'Never answered automatically - you answer this yourself on the form' : qn.decision === 'ask' ? `Check before sending: ${qn.value || '(no answer on file)'}` : qn.value || '(no answer on file)'} />
        ))}
      </Card>

      <Card>
        <Title level={3}>Documents ({a.documents.length})</Title>
        {a.documents.length === 0 ? <Muted>No documents in this folder.</Muted> : null}
        {a.documents.map((d) => (
          <Button key={d.id} title={`${humanise(d.kind)} · ${d.format.toUpperCase()} v${d.version}${d.status === 'submitted' ? ' (sealed)' : ''}`} variant="secondary" busy={busy === d.id} disabled={offline || busy !== null} onPress={() => openDocument(d.id)} accessibilityHint="Opens a ten-minute link to the document in the browser" />
        ))}
        <Muted style={{ marginTop: 8 }}>Documents are opened, not stored, on this device. Editing them happens on the web.</Muted>
      </Card>

      <Card>
        <Title level={3}>Folder</Title>
        {a.completeness.answers.map((x) => (
          <KeyValue key={x.question} label={x.label} value={`${x.ok ? '✓' : '·'} ${x.detail}`} />
        ))}
        <KeyValue label="Contacts" value={a.contacts.length === 0 ? 'None' : a.contacts.map((c) => `${c.name} (${humanise(c.role)})`).join(', ')} />
        <KeyValue label="Interviews" value={a.interviews.length === 0 ? 'None' : a.interviews.map((i) => `${humanise(i.kind)} ${formatDateTime(i.scheduledAt)}`).join('; ')} />
        <KeyValue label="Follow-ups" value={a.followUps.length === 0 ? 'None' : a.followUps.map((f) => `${humanise(f.channel)} due ${formatDate(f.dueAt)}${f.doneAt ? ' (done)' : ''}`).join('; ')} />
        <KeyValue label="Assessments" value={a.assessments.length === 0 ? 'None' : a.assessments.map((s) => `${humanise(s.kind)} ${humanise(s.result)}`).join('; ')} />
        <KeyValue label="Notes" value={`${a.notesCount} on the web`} />
        <KeyValue label="Mail & calendar" value={`${a.communications.threads} thread${a.communications.threads === 1 ? '' : 's'}, ${a.communications.calendarEvents} event${a.communications.calendarEvents === 1 ? '' : 's'}`} />
      </Card>

      <Card>
        <Title level={3}>History</Title>
        {a.history.map((h, i) => (
          <KeyValue key={i} label={formatDateTime(h.at)} value={`${statusLabel(h.toStatus)} (${h.actor}${h.source ? `, ${h.source}` : ''})${h.reason ? ` - ${h.reason}` : ''}`} />
        ))}
      </Card>
    </Screen>
  );
}
