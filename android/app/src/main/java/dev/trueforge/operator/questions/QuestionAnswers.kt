package dev.trueforge.operator.questions

/** Keeps notification and in-app question answer rules identical and testable. */
object QuestionAnswers {
    const val MAX_OPTIONS = 5

    fun options(values: List<String>): List<String> = values
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()
        .take(MAX_OPTIONS)

    fun normalize(value: CharSequence?): String? = value
        ?.toString()
        ?.trim()
        ?.takeIf(String::isNotEmpty)
}
