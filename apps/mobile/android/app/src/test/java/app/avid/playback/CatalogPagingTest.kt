package app.avid.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CatalogPagingTest {
    @Test fun pagesWithoutDuplicatesOrOverflow() {
        val source = (1..7).toList()
        assertEquals(listOf(1, 2, 3), catalogPage(source, 0, 3))
        assertEquals(listOf(4, 5, 6), catalogPage(source, 1, 3))
        assertEquals(listOf(7), catalogPage(source, 2, 3))
        assertEquals(emptyList<Int>(), catalogPage(source, Int.MAX_VALUE, 500))
    }
    @Test fun rejectsUnboundedOrNegativeControllerRequests() {
        assertThrows(IllegalArgumentException::class.java) { catalogPage(listOf(1), -1, 10) }
        assertThrows(IllegalArgumentException::class.java) { catalogPage(listOf(1), 0, 0) }
        assertThrows(IllegalArgumentException::class.java) { catalogPage(listOf(1), 0, Int.MAX_VALUE) }
    }
}
