package tv.imperum.app

import android.util.JsonReader
import android.util.JsonToken
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.Writer

/**
 * Große Listen des Anbieters (Sender, Filme, Serien) im Android-Teil lesen, statt in der Oberfläche.
 *
 * Die Antwort des Anbieters wird Stück für Stück gelesen (nie komplett im Speicher) und auf die
 * wenigen Angaben gekürzt, die die App anzeigt. Heraus kommt eine kleine Liste in Zeilen
 * (je Zeile ein JSON-Feld mit bis zu [CHUNK] Einträgen), die die Oberfläche häppchenweise einliest.
 *
 * Die Umrechnung entspricht genau mapList() in app.js:
 *   live:   [id, num, name, logo, catId, epg]
 *   movie:  [id, name, logo, catId, ext, year|null, rating, added]
 *   series: [id, name, logo, catId, year|null, rating, added]
 */
object ListMapper {
    private const val CHUNK = 2000

    class NotJson(val prefix: String) : Exception("not json")

    private val LIVE_KEYS = setOf("stream_id", "name", "stream_icon", "category_id", "epg_channel_id")
    private val MOVIE_KEYS = setOf("stream_id", "name", "stream_icon", "category_id", "container_extension",
        "year", "release_date", "releaseDate", "rating", "rating_5based", "added")
    private val SERIES_KEYS = setOf("series_id", "name", "cover", "category_id", "releaseDate", "release_date",
        "year", "rating", "rating_5based", "last_modified")

    private val YEAR = Regex("(19|20)\\d{2}")
    private val YEAR_BRACKET = Regex("[(\\[](19|20)\\d{2}[)\\]]")
    private val YEAR_END = Regex("[ ._-](19|20)\\d{2}\\z")
    private val INT_FLOAT = Regex("^-?\\d+\\.0+$")
    private val FLOAT_START = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")

    /** Liest die Anbieter-Antwort und liefert die kleine Liste als UTF-8-Bytes. */
    fun map(raw: InputStream, encoding: String, kind: String): ByteArray {
        val cs = try { java.nio.charset.Charset.forName(encoding) } catch (e: Throwable) { Charsets.UTF_8 }
        val input = BufferedInputStream(raw, 64 * 1024)
        // Byte-Order-Mark am Anfang überspringen (manche Server schicken eins)
        input.mark(8)
        val bom = ByteArray(3)
        val got = input.read(bom, 0, 3)
        input.reset()
        if (got == 3 && bom[0] == 0xEF.toByte() && bom[1] == 0xBB.toByte() && bom[2] == 0xBF.toByte()) input.skip(3)

        val keys = when (kind) { "movie" -> MOVIE_KEYS; "series" -> SERIES_KEYS; else -> LIVE_KEYS }
        val bytes = ByteArrayOutputStream(256 * 1024)
        val out = OutputStreamWriter(bytes, Charsets.UTF_8).buffered(64 * 1024)
        val reader = JsonReader(InputStreamReader(input, cs))
        reader.isLenient = true
        try {
            // Keine Liste (Fehlerseite, Objekt …): Ausnahme → die Oberfläche liest es selbst und meldet den Fehler wie bisher
            if (reader.peek() != JsonToken.BEGIN_ARRAY) throw NotJson("")
            reader.beginArray()
            var index = 0
            var inLine = 0
            val fields = HashMap<String, String?>(16)
            while (reader.hasNext()) {
                index++
                if (reader.peek() != JsonToken.BEGIN_OBJECT) { reader.skipValue(); continue }
                fields.clear()
                reader.beginObject()
                while (reader.hasNext()) {
                    val name = reader.nextName()
                    if (name in keys) fields[name] = readValue(reader) else reader.skipValue()
                }
                reader.endObject()
                if (!writeItem(out, kind, fields, index, inLine == 0)) continue
                inLine++
                if (inLine >= CHUNK) { out.write("]\n"); inLine = 0 }
            }
            if (inLine > 0) out.write("]\n")
            out.flush()
            return bytes.toByteArray()
        } finally {
            try { reader.close() } catch (e: Throwable) { }
        }
    }

    /** Wert so lesen, wie ihn String(v) in JavaScript liefern würde (null = fehlt/null). */
    private fun readValue(r: JsonReader): String? = when (r.peek()) {
        JsonToken.STRING -> r.nextString()
        JsonToken.NUMBER -> { val s = r.nextString(); if (INT_FLOAT.matches(s)) s.substringBefore('.') else s }
        JsonToken.BOOLEAN -> r.nextBoolean().toString()
        JsonToken.NULL -> { r.nextNull(); null }
        else -> { r.skipValue(); null }
    }

    private fun str(v: String?): String {
        if (v == null) return ""
        val s = v.trim()
        return if (s == "0" || s.equals("null", ignoreCase = true) || s == "N/A") "" else s
    }

    private fun firstYear(text: String): Int? = YEAR.find(text)?.value?.toIntOrNull()

    private fun yearFromName(name: String): Int? {
        val m = YEAR_BRACKET.find(name) ?: YEAR_END.find(name) ?: return null
        return firstYear(m.value)
    }

    /** parseInt(v, 10) wie in JavaScript (null = NaN) */
    private fun jsInt(v: String?): Long? {
        if (v == null) return null
        var i = 0
        val s = v
        while (i < s.length && s[i].isWhitespace()) i++
        var neg = false
        if (i < s.length && (s[i] == '+' || s[i] == '-')) { neg = s[i] == '-'; i++ }
        val start = i
        while (i < s.length && s[i] in '0'..'9') i++
        if (i == start) return null
        val digits = s.substring(start, i).take(18)
        val n = digits.toLongOrNull() ?: return null
        return if (neg) -n else n
    }

    /** parseFloat(v) wie in JavaScript (NaN, wenn keine Zahl am Anfang steht) */
    private fun jsFloat(v: String?): Double {
        if (v == null) return Double.NaN
        val s = v.trimStart()
        val m = FLOAT_START.find(s) ?: return Double.NaN
        return m.value.toDoubleOrNull() ?: Double.NaN
    }

    private fun rating(r: String?, r5: String?): Double {
        var v = jsFloat(r)
        if (v > 10 && v <= 100) v /= 10
        if (!(v > 0) || v > 10) v = jsFloat(r5) * 2
        if (!(v > 0) || v > 10) return 0.0
        return Math.round(v * 10) / 10.0
    }

    private fun writeItem(out: Writer, kind: String, f: Map<String, String?>, index: Int, firstInLine: Boolean): Boolean {
        val idRaw = if (kind == "series") f["series_id"] else f["stream_id"]
        val id = jsInt(idRaw) ?: return false
        val idText = idRaw ?: "undefined"
        val cat = f["category_id"] ?: ""
        out.write(if (firstInLine) "[[" else ",[")
        out.write(id.toString())
        when (kind) {
            "live" -> {
                out.write(","); out.write(index.toString())
                out.write(","); quote(out, str(f["name"]).ifEmpty { "Sender $idText" })
                out.write(","); quote(out, str(f["stream_icon"]))
                out.write(","); quote(out, cat)
                out.write(","); quote(out, str(f["epg_channel_id"]))
            }
            "movie" -> {
                val name = str(f["name"]).ifEmpty { "Film $idText" }
                val year = firstYear(str(f["year"])) ?: firstYear(str(f["release_date"])) ?: firstYear(str(f["releaseDate"])) ?: yearFromName(name)
                out.write(","); quote(out, name)
                out.write(","); quote(out, str(f["stream_icon"]))
                out.write(","); quote(out, cat)
                out.write(","); quote(out, str(f["container_extension"]).ifEmpty { "mp4" })
                out.write(","); out.write(year?.toString() ?: "null")
                out.write(","); out.write(num(rating(f["rating"], f["rating_5based"])))
                out.write(","); out.write((jsInt(f["added"]) ?: 0L).toString())
            }
            else -> {
                val name = str(f["name"]).ifEmpty { "Serie $idText" }
                val year = firstYear(str(f["releaseDate"])) ?: firstYear(str(f["release_date"])) ?: firstYear(str(f["year"])) ?: yearFromName(name)
                out.write(","); quote(out, name)
                out.write(","); quote(out, str(f["cover"]))
                out.write(","); quote(out, cat)
                out.write(","); out.write(year?.toString() ?: "null")
                out.write(","); out.write(num(rating(f["rating"], f["rating_5based"])))
                out.write(","); out.write((jsInt(f["last_modified"]) ?: 0L).toString())
            }
        }
        out.write("]")
        return true
    }

    private fun num(d: Double): String = if (d == Math.floor(d)) d.toLong().toString() else d.toString()

    private fun quote(out: Writer, s: String) {
        out.write('"'.code)
        for (c in s) {
            when {
                c == '"' -> out.write("\\\"")
                c == '\\' -> out.write("\\\\")
                c == '\n' -> out.write("\\n")
                c == '\r' -> out.write("\\r")
                c == '\t' -> out.write("\\t")
                c < ' ' || c == ' ' || c == ' ' -> out.write(String.format("\\u%04x", c.code))
                else -> out.write(c.code)
            }
        }
        out.write('"'.code)
    }
}
