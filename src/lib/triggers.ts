// Event triggers — downstream effects fired after CRUD operations.
// Each trigger is called from the API route after the primary operation succeeds.
// Triggers create notifications, cascade status changes, and log activity.
// They never fail the parent operation — errors are logged and swallowed.

import { getTask, getMilestone, getProject, getContract, getTasksByMilestone, getMilestonesByProject, updateMilestone, updateProject, updateTask, updateContract } from './contracts';
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
        client_update_text: `${milestone.title} completed \u2014 all tasks finished`,
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
    }
  } catch (err) {
    logger.error('Trigger onPaymentRecorded failed', err);
  }
}
