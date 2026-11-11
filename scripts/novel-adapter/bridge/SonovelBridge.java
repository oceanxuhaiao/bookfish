import java.nio.charset.StandardCharsets;

import cn.hutool.json.JSONUtil;
import cn.hutool.log.dialect.console.ConsoleLog;
import cn.hutool.log.level.Level;
import com.pcdd.sonovel.context.BookContext;
import com.pcdd.sonovel.context.HttpClientContext;
import com.pcdd.sonovel.context.OkHttpClientFactory;
import com.pcdd.sonovel.core.AppConfigLoader;
import com.pcdd.sonovel.model.AppConfig;
import com.pcdd.sonovel.model.Rule;
import com.pcdd.sonovel.parser.BookParser;
import com.pcdd.sonovel.parser.SearchParser;
import com.pcdd.sonovel.parser.TocParser;
import com.pcdd.sonovel.utils.SourceUtils;

/**
 * Minimal read-only bridge to so-novel's own search/catalog parsers.
 *
 * Compiled against the official v1.12.0 fat jar; upstream sources are not modified.
 * Bookfish consumes one JSON document per invocation and keeps downloads,
 * validation and task lifecycle on its own side.
 *
 * Usage:
 *   search <sourceId> <query>
 *   toc <bookUrl>
 *   book <bookUrl>
 */
public final class SonovelBridge {
    private static final String MARKER = "SONOVEL_JSON=";

    private SonovelBridge() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: search <sourceId> <query> | toc <bookUrl> | book <bookUrl>");
            System.exit(2);
        }
        ConsoleLog.setLevel(Level.OFF);
        AppConfig cfg = AppConfigLoader.APP_CONFIG;
        cfg.setExtName("txt");
        cfg.setPreserveChapterCache(1);
        cfg.setEnableProgressbar(0);
        cfg.setConcurrency(1);
        cfg.setSearchFilter(0);
        HttpClientContext.set(OkHttpClientFactory.create(cfg));

        Object result;
        String mode = args[0];
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
        } else {
            throw new IllegalArgumentException("unknown mode: " + mode);
        }
        byte[] json = (MARKER + JSONUtil.toJsonStr(result)).getBytes(StandardCharsets.UTF_8);
        System.out.write(json);
        System.out.flush();
        // Parsers may leave non-daemon pools alive; this is a one-shot bridge.
        System.exit(0);
    }
}
