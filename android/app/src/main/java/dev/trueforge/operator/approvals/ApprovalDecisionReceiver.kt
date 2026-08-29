package dev.trueforge.operator.approvals

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Delivers Allow/Deny taps from the approval notification to the coordinator. */
class ApprovalDecisionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_DECIDE = "dev.trueforge.operator.APPROVAL_DECISION"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_DECISION = "decision"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECIDE) return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION) ?: "deny"
        ApprovalCoordinator.resolve(
            context,
            requestId,
            decision,
            reason = if (decision == "allow") null else "denied from notification",
        )
    }
}
