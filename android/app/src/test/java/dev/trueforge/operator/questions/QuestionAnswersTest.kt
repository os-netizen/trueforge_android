package dev.trueforge.operator.questions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuestionAnswersTest {
    @Test
    fun `options are trimmed deduplicated and bounded for notification choices`() {
        assertEquals(
            listOf("Alpha", "Beta", "Gamma", "Delta", "Epsilon"),
            QuestionAnswers.options(
                listOf(" Alpha ", "", "Beta", "Alpha", "Gamma", "Delta", "Epsilon", "Zeta"),
            ),
        )
    }

    @Test
    fun `answer accepts a trimmed choice or free text`() {
        assertEquals("Alpha", QuestionAnswers.normalize("  Alpha  "))
        assertEquals("A custom answer", QuestionAnswers.normalize(StringBuilder(" A custom answer ")))
    }

    @Test
    fun `blank answer is rejected`() {
        assertNull(QuestionAnswers.normalize(null))
        assertNull(QuestionAnswers.normalize("   "))
    }
}
