package com.dafeiyu.companion

import org.junit.Assert.*
import org.junit.Test

class WechatPreviewTest {
    @Test fun acceptsTheObservedHonorWechatUnreadSummary() {
        assertEquals(2, WechatPreview.aggregateCount("爸爸", "[2条]爸爸: M1通信测试"))
        assertEquals(1, WechatPreview.aggregateCount("爸爸", "M1通信测试"))
        assertEquals(2, WechatPreview.aggregateCount("爸爸", "[2条]爸爸：M1通信测试"))
    }
    @Test fun rejectsAmbiguousSendersAndMalformedSummaries() {
        assertNull(WechatPreview.aggregateCount("爸爸", "[2条]其他人: M1通信测试"))
        assertNull(WechatPreview.aggregateCount("爸爸", "[2条]M1通信测试"))
        assertNull(WechatPreview.aggregateCount("爸爸", "[0条]爸爸: 内容"))
        assertNull(WechatPreview.aggregateCount("爸爸", "[999999999999条]爸爸: 内容"))
        assertNull(WechatPreview.aggregateCount("爸爸", ""))
    }
}
