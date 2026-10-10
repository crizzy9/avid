package app.avid.playback

/** Untrusted controller paging cannot overflow or allocate unbounded result sets. */
fun <T> catalogPage(items: List<T>, page: Int, pageSize: Int): List<T> {
    require(page >= 0 && pageSize in 1..500) { "Invalid catalog page." }
    val start = page.toLong() * pageSize.toLong()
    if (start >= items.size) return emptyList()
    return items.subList(start.toInt(), minOf(items.size.toLong(), start + pageSize).toInt())
}
