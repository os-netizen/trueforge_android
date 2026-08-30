package dev.trueforge.operator.accessibility

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TextEntryFallbackTest {
    @Test
    fun `uses the requested node when it accepts text`() = runBlocking {
        val calls = mutableListOf<String>()

        val ok = setTextWithFocusedFallback(
            target = "wrapper",
            value = "Pune Airport",
            setText = { node, _ -> calls.add("set:$node"); true },
            focus = { calls.add("focus:$it") },
            awaitFocused = { calls.add("await"); "editor" },
        )

        assertTrue(ok)
        assertEquals(listOf("set:wrapper"), calls)
    }

    @Test
    fun `retries against the actual focused editor`() = runBlocking {
        val calls = mutableListOf<String>()

        val ok = setTextWithFocusedFallback(
            target = "wrapper",
            value = "Pune Airport",
            setText = { node, _ -> calls.add("set:$node"); node == "editor" },
            focus = { calls.add("focus:$it") },
            awaitFocused = { calls.add("await"); "editor" },
        )

        assertTrue(ok)
        assertEquals(
            listOf("set:wrapper", "focus:wrapper", "await", "set:editor"),
            calls,
        )
    }

    @Test
    fun `fails without inventing input when Android exposes no focus`() = runBlocking {
        val calls = mutableListOf<String>()

        val ok = setTextWithFocusedFallback(
            target = "wrapper",
            value = "Pune Airport",
            setText = { node, _ -> calls.add("set:$node"); false },
            focus = { calls.add("focus:$it") },
            awaitFocused = { calls.add("await"); null },
        )

        assertFalse(ok)
        assertEquals(listOf("set:wrapper", "focus:wrapper", "await"), calls)
    }
}
