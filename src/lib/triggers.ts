// Event triggers — downstream effects fired after CRUD operations.
// Each trigger is called from the API route after the primary operation succeeds.
// Triggers create notifications, cascade status changes, and log activity.
// They never fail the parent operation — errors are logged and swallowed.

import { getTask, getMilestone, getProject, getContract, getTasksByMilestone, getMilestonesByProject, updateMilestone, updateProject, updateTask, updateContract, createProject, getProjectsByContract } from './contracts';
import { getInvoice, getChangeOrder } from './invoices';
import { createPendingCharge } from './billing';
import { createNotification } from './notifications';
import { getUsersByClientId, getAdminUsers } from './auth';
import { logActivity } from './activity';
import { logger } from './logger';

// Helper: notify all client users on a contract
async function notifyClientUsers(contractId: string, notification: { type: Parameters<typeof createNotification>[0]['type']; title: string; body: string; entity_type?: string; entity_id?: string }) {
  const contract = await getContract(contractId);
  if (!contract) return;
  const users = await getUsersByClientId(contract.client_id);
  for (const user of users) {
    await createNotification({ user_id: user.id, ...notification });
  }
}

// Helper: notify all admin users
async function notifyAdmins(notification: { type: Parameters<typeof createNotification>[0]['type']; title: string; body: string; entity_type?: string; entity_id?: string }) {
  const admins = await getAdminUsers();
  for (const admin of admins) {
    await createNotification({ user_id: admin.id, ...notification });
  }
}

// A client asked for fresher data on one of their live pages. Not all
// sources are auto-connected (a site crawl is a manual or paid step), so the
// page offers a request button that pings Cody to refresh. In-portal
// notification only today (no email on this path).
export async function onDataUpdateRequested(args: { clientId: string; clientName: string; sourceLabel: string; requestedByName: string }): Promise<void> {
  try {
    await notifyAdmins({
      type: 'data_update_requested',
      title: `Data update requested: ${args.clientName}`,
      body: `${args.requestedByName} requested fresher ${args.sourceLabel} data for ${args.clientName}.`,
      entity_type: 'client',
      entity_id: args.clientId,
    });
  } catch (err) {
    logger.error('onDataUpdateRequested failed', err);
  }
}

// Cody deliberately issued a prescriptive deliverable (a strategic
// recommendation or a research report) to the client. This is the delivery
// event: notify the client in-portal and email them. Value-first copy
// (what they get, not what the system did). Fired once per file, from
// /portal/api/files/issue.
export async function onDocumentIssued(args: { clientId: string; fileId: string; fileName: string; category: string }): Promise<void> {
  try {
    const { fileCategoryLabel } = await import('./storage');
    const { escapeHtml } = await import('./email-safety');
    const label = fileCategoryLabel(args.category);
    const users = await getUsersByClientId(args.clientId);

    for (const user of users) {
      await createNotification({
        user_id: user.id,
        type: 'document_issued',
        title: `New ${label} ready`,
        body: `"${args.fileName}" is ready to read in your documents.`,
        entity_type: 'file',
        entity_id: args.fileId,
      });
    }

    if (users.length > 0) {
      const { sendEmail } = await import('./email');
      const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
      const safeName = escapeHtml(args.fileName);
      await sendEmail(
        users.map(u => ({ email: u.email, name: u.name })),
        `New ${label} ready in your portal`,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">Something new to read</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">I just added <strong>${safeName}</strong> to your portal. It is ready whenever you are.</p>
          <a href="${portalUrl}/portal/documents" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">Open your documents</a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;"><a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a></p>
        </div>
        `
      );
    }
  } catch (err) {
    logger.error('onDocumentIssued failed', err);
  }
}

// ============================================================
// Trigger 1: Task marked complete
// ============================================================
export async function onTaskCompleted(taskId: string): Promise<void> {
  try {
    const task = await getTask(taskId);
    if (!task || task.status !== 'done') return;

    const milestone = await getMilestone(task.milestone_id);
    if (!milestone) return;

    const project = milestone ? await getProject(milestone.project_id) : null;
    const contract = project ? await getContract(project.contract_id) : null;

    // Auto-write client update text (System 5)
    const completedDate = new Date().toISOString().split('T')[0];
    if (task.client_visible) {
      await updateTask(taskId, {
        client_update_text: `${task.title} completed on ${completedDate}`,
      });
    }

    // Notify client
    if (contract) {
      await notifyClientUsers(contract.id, {
        type: 'task_completed',
        title: 'Task completed',
        body: `"${task.title}" in ${milestone.title} is done`,
        entity_type: 'task',
        entity_id: taskId,
      });
    }

    // Check if all tasks in milestone are done → auto-complete milestone
    const allTasks = await getTasksByMilestone(milestone.id);
    const allDone = allTasks.length > 0 && allTasks.every(t => t.status === 'done');
    if (allDone && milestone.status !== 'completed') {
      await updateMilestone(milestone.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      });
      await onMilestoneCompleted(milestone.id);
    }
  } catch (err) {
    logger.error('Trigger onTaskCompleted failed', err);
  }
}

// ============================================================
// Trigger 2: Milestone marked complete
// ============================================================
export async function onMilestoneCompleted(milestoneId: string): Promise<void> {
  try {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) return;

    const project = await getProject(milestone.project_id);
    if (!project) return;

    const contract = await getContract(project.contract_id);

    // Auto-write client update text (System 5)
    if (milestone.client_visible) {
      await updateMilestone(milestoneId, {
        client_update_text: `${milestone.title} completed, all tasks finished`,
      });
    }

    // Notify client
    if (contract) {
      await notifyClientUsers(contract.id, {
        type: 'milestone_completed',
        title: 'Milestone completed',
        body: `"${milestone.title}" in ${project.title} is complete`,
        entity_type: 'milestone',
        entity_id: milestoneId,
      });
    }

    // Check if all milestones in project are done → auto-complete project
    const allMilestones = await getMilestonesByProject(project.id);
    const allDone = allMilestones.length > 0 && allMilestones.every(m => m.status === 'completed');
    if (allDone && project.status !== 'completed') {
      await updateProject(project.id, { status: 'completed' });

      if (contract) {
        await notifyClientUsers(contract.id, {
          type: 'milestone_completed',
          title: 'Project completed',
          body: `${project.title} is complete`,
          entity_type: 'project',
          entity_id: project.id,
        });
      }
    }
  } catch (err) {
    logger.error('Trigger onMilestoneCompleted failed', err);
  }
}

// ============================================================
// Trigger 3: Approval responded
// ============================================================
export async function onApprovalResponded(approvalId: string, status: string, respondedByName: string): Promise<void> {
  try {
    const approval = await (await import('./invoices')).getApproval(approvalId);
    if (!approval) return;

    const statusLabel = status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'requested revision on';

    // Notify admin
    await notifyAdmins({
      type: 'approval_responded',
      title: `Approval ${status}`,
      body: `${respondedByName} ${statusLabel} "${approval.title}"`,
      entity_type: 'approval',
      entity_id: approvalId,
    });
  } catch (err) {
    logger.error('Trigger onApprovalResponded failed', err);
  }
}

// ============================================================
// Trigger 4: Change order approved
// ============================================================
export async function onChangeOrderApproved(changeOrderId: string): Promise<void> {
  try {
    const co = await getChangeOrder(changeOrderId);
    if (!co) return;

    const contract = await getContract(co.contract_id);
    if (!contract) return;

    // Update contract total_value
    if (co.cost_impact !== 0 && contract.total_value != null) {
      await updateContract(co.contract_id, {
        total_value: contract.total_value + co.cost_impact,
      });
    }

    // Create pending billable charge (System 6)
    if (co.cost_impact > 0) {
      const approvedDate = co.approved_at ? co.approved_at.split('T')[0] : new Date().toISOString().split('T')[0];
      await createPendingCharge({
        contract_id: co.contract_id,
        description: `${co.title} (approved ${approvedDate})`,
        amount: co.cost_impact,
        source_type: 'change_order',
        source_id: co.id,
      });
    }

    // Notify client
    await notifyClientUsers(contract.id, {
      type: 'change_order_approved',
      title: 'Scope updated',
      body: `"${co.title}" approved${co.cost_impact ? ` (+$${co.cost_impact.toFixed(2)})` : ''}`,
      entity_type: 'change_order',
      entity_id: changeOrderId,
    });
  } catch (err) {
    logger.error('Trigger onChangeOrderApproved failed', err);
  }
}

// ============================================================
// Trigger 5: Invoice sent
// ============================================================
export async function onInvoiceSent(invoiceId: string): Promise<void> {
  try {
    const invoice = await getInvoice(invoiceId);
    if (!invoice) return;

    await notifyClientUsers(invoice.contract_id, {
      type: 'invoice_sent',
      title: 'Invoice ready',
      body: `Invoice ${invoice.invoice_number} ($${invoice.total.toFixed(2)}) is ready for review`,
      entity_type: 'invoice',
      entity_id: invoiceId,
    });
  } catch (err) {
    logger.error('Trigger onInvoiceSent failed', err);
  }
}

// ============================================================
// Trigger 6: Payment recorded
// ============================================================
export async function onPaymentRecorded(invoiceId: string, amount: number): Promise<void> {
  try {
    const invoice = await getInvoice(invoiceId);
    if (!invoice) return;

    // Notify admin
    await notifyAdmins({
      type: 'payment_received',
      title: 'Payment received',
      body: `$${amount.toFixed(2)} received on invoice ${invoice.invoice_number}`,
      entity_type: 'invoice',
      entity_id: invoiceId,
    });

    // If invoice is now fully paid, notify client
    if (invoice.amount_paid >= invoice.total) {
      await notifyClientUsers(invoice.contract_id, {
        type: 'payment_received',
        title: 'Invoice paid',
        body: `Invoice ${invoice.invoice_number} is paid in full`,
        entity_type: 'invoice',
        entity_id: invoiceId,
      });

      // At-signing invoice cleared = work can start (contract section 5.2).
      // An at-signing invoice carries no billing period (recurring ones do).
      if (!invoice.billing_period_start) {
        await onAtSigningInvoicePaid(invoice.contract_id);
      }
    }
  } catch (err) {
    logger.error('Trigger onPaymentRecorded failed', err);
  }
}

// ============================================================
// Trigger 6b: At-signing invoice cleared -> work starts
// ============================================================
// The throughput model gates work on cleared funds. When the at-signing
// invoice is paid in full, auto-create the engagement project shell (a
// home for work tracking; milestones/tasks are Cody's judgment, not
// auto-filled), flag the admin that work can begin, and tell the client
// they are underway. Idempotent: only fires when the contract has no
// project yet, so repeat payments do not duplicate it.
async function onAtSigningInvoicePaid(contractId: string): Promise<void> {
  const contract = await getContract(contractId);
  if (!contract) return;

  const existing = await getProjectsByContract(contractId);
  if (existing.length > 0) return; // already kicked off

  const projectId = await createProject({
    contract_id: contractId,
    client_id: contract.client_id,
    title: 'Engagement kickoff',
    description: 'Your engagement is underway. Milestones will appear here as the work plan is set.',
    client_visible: true,
  });

  await notifyAdmins({
    type: 'payment_received',
    title: 'Work can start',
    body: `At-signing payment cleared for ${contract.title}. The "Engagement kickoff" project is ready; add milestones and begin.`,
    entity_type: 'project',
    entity_id: projectId,
  });

  // Value-first nudge to the client: payment in, work underway.
  try {
    const { sendEmail } = await import('./email');
    const users = await getUsersByClientId(contract.client_id);
    if (users.length > 0) {
      const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
      await sendEmail(
        users.map(u => ({ email: u.email, name: u.name })),
        `Payment received. We are underway on ${contract.title}.`,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">We are underway</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">Your payment cleared and work has started. You will see progress land in your portal as it happens.</p>
          <a href="${portalUrl}/portal" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">Open your portal</a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;"><a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a></p>
        </div>
        `
      );
    }
  } catch (err) {
    logger.error('onAtSigningInvoicePaid client email failed', err);
  }
}
