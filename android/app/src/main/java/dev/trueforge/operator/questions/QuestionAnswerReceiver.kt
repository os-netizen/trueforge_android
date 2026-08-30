package dev.trueforge.operator.questions

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

/** Delivers a choice or free-text reply from the notification to the coordinator. */
class QuestionAnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ANSWER) return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val answer = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(REMOTE_INPUT_KEY)
            ?.toString()
        QuestionCoordinator.resolve(context, requestId, answer)
    }

    companion object {
        const val ACTION_ANSWER = "dev.trueforge.operator.QUESTION_ANSWER"
        const val EXTRA_REQUEST_ID = "request_id"
        const val REMOTE_INPUT_KEY = "question_answer"
    }
}
