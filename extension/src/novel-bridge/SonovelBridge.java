import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONUtil;
import cn.hutool.log.dialect.console.ConsoleLog;
import cn.hutool.log.level.Level;
import com.pcdd.sonovel.context.BookContext;
import com.pcdd.sonovel.context.HttpClientContext;
import com.pcdd.sonovel.context.OkHttpClientFactory;
import com.pcdd.sonovel.core.AppConfigLoader;
import com.pcdd.sonovel.model.AppConfig;
import com.pcdd.sonovel.model.Chapter;
import com.pcdd.sonovel.model.Rule;
import com.pcdd.sonovel.parser.BookParser;
import com.pcdd.sonovel.parser.ChapterParser;
import com.pcdd.sonovel.parser.SearchParser;
import com.pcdd.sonovel.parser.TocParser;
import com.pcdd.sonovel.utils.FileUtils;
import com.pcdd.sonovel.utils.SourceUtils;

/**
 * Minimal read-only bridge to so-novel's own search/catalog parsers.
 *
 * Compiled against the official v1.12.0 fat jar; upstream sources are not modified.
 * Bookfish consumes one JSON document per invocation and keeps downloads,
 * validation and task lifecycle on its own side.
 *
 * Usage:
 *   health <rulesFile>
 *   search <sourceId> <query>
 *   toc <bookUrl>
 *   book <bookUrl>
 *   download <bookUrl> <ordersFile>
 */
public final class SonovelBridge {
    private static final String MARKER = "SONOVEL_JSON=";
    private static final String HEALTH_MARKER = "SONOVEL_HEALTH=";
    private static final int PROTOCOL = 1;

    private SonovelBridge() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: health <rulesFile> | search <sourceId> <query> | toc <bookUrl> | book <bookUrl> | download <bookUrl> <ordersFile>");
            System.exit(2);
        }
        ConsoleLog.setLevel(Level.OFF);
        String mode = args[0];
        if ("health".equals(mode)) {
            System.out.write((HEALTH_MARKER + health(args[1])).getBytes(StandardCharsets.UTF_8));
            System.out.flush();
            System.exit(0);
        }

        AppConfig cfg = AppConfigLoader.APP_CONFIG;
        cfg.setExtName("txt");
        cfg.setPreserveChapterCache(1);
        cfg.setEnableProgressbar(0);
        cfg.setConcurrency(1);
        cfg.setSearchFilter(0);
        HttpClientContext.set(OkHttpClientFactory.create(cfg));

        Object result;
        if ("search".equals(mode)) {
            cfg.setSourceId(Integer.parseInt(args[1]));
            result = new SearchParser(cfg).parse(args[2]);
        } else if ("toc".equals(mode)) {
            Rule rule = SourceUtils.getRule(args[1]);
            cfg.setSourceId(rule.getId());
            result = new TocParser(cfg).parseAll(args[1]);
        } else if ("book".equals(mode)) {
            Rule rule = SourceUtils.getRule(args[1]);
            cfg.setSourceId(rule.getId());
            BookContext.set(new BookParser(cfg).parse(args[1]));
            result = BookContext.get();
        } else if ("download".equals(mode)) {
            if (args.length < 3) throw new IllegalArgumentException("download needs <bookUrl> <ordersFile>");
            Rule rule = SourceUtils.getRule(args[1]);
            cfg.setSourceId(rule.getId());
            Rule.Book book = new BookParser(cfg).parse(args[1]);
            BookContext.set(book);
            List<Chapter> toc = new TocParser(cfg).parseAll(args[1]);
            Set<Integer> wanted = Files.readAllLines(Path.of(args[2]), StandardCharsets.UTF_8).stream()
                    .map(String::trim).filter(s -> !s.isEmpty()).map(Integer::valueOf).collect(Collectors.toSet());
            int digits = String.valueOf(toc.size()).length();
            String bookDir = FileUtils.sanitizeFileName("%s (%s) %s".formatted(book.getBookName(), book.getAuthor(), cfg.getExtName().toUpperCase()));
            Path dir = Path.of(cfg.getDownloadPath(), bookDir);
            Files.createDirectories(dir);
            ChapterParser parser = new ChapterParser(cfg);
            int written = 0;
            for (Chapter item : toc) {
                if (!wanted.contains(item.getOrder())) continue;
                Chapter chapter = parser.parse(item);
                if (chapter == null) continue;
                String order = String.format("%0" + digits + "d", chapter.getOrder());
                String name = order + "_" + FileUtils.sanitizeFileName(chapter.getTitle()) + ".txt";
                Files.writeString(dir.resolve(name), chapter.getContent(), StandardCharsets.UTF_8);
                written++;
            }
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("written", written);
            summary.put("total", toc.size());
            result = summary;
        } else {
            throw new IllegalArgumentException("unknown mode: " + mode);
        }
        byte[] json = (MARKER + JSONUtil.toJsonStr(result)).getBytes(StandardCharsets.UTF_8);
        System.out.write(json);
        System.out.flush();
        // Parsers may leave non-daemon pools alive; this is a one-shot bridge.
        System.exit(0);
    }

    /**
     * Offline self-check: no HTTP is issued. It verifies that the engine classes
     * shipped next to this bridge can be loaded, that the rule file is valid
     * JSON with the expected shape, and reports digests for the caller to pin.
     */
    private static String health(String rulesFile) throws Exception {
        Map<String, Object> checks = new LinkedHashMap<>();
        String[] classes = {
                "com.pcdd.sonovel.core.AppConfigLoader",
                "com.pcdd.sonovel.parser.SearchParser",
                "com.pcdd.sonovel.parser.TocParser",
                "com.pcdd.sonovel.parser.BookParser",
                "com.pcdd.sonovel.parser.ChapterParser",
                "com.pcdd.sonovel.utils.SourceUtils",
        };
        boolean classesOk = true;
        ClassLoader loader = SonovelBridge.class.getClassLoader();
        for (String name : classes) {
            try {
                Class.forName(name, false, loader);
                checks.put(name, true);
            } catch (Throwable error) {
                checks.put(name, false);
                classesOk = false;
            }
        }
        Path path = Path.of(rulesFile);
        byte[] bytes = Files.readAllBytes(path);
        String sha = hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        JSONArray array = JSONUtil.parseArray(new String(bytes, StandardCharsets.UTF_8));
        boolean rulesOk = array.size() > 0;
        checks.put("rulesJson", rulesOk);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("protocol", PROTOCOL);
        payload.put("ok", classesOk && rulesOk);
        payload.put("javaVersion", System.getProperty("java.version"));
        payload.put("javaVendor", System.getProperty("java.vendor"));
        payload.put("soNovelVersion", System.getProperty("bookfish.soNovelVersion", "unknown"));
        payload.put("rulesSha256", sha);
        payload.put("rulesSources", array.size());
        payload.put("checks", checks);
        return JSONUtil.toJsonStr(payload);
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) builder.append(String.format("%02x", value));
        return builder.toString();
    }
}
