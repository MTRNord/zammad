<!-- Copyright (C) 2012-2023 Zammad Foundation, https://zammad-foundation.org/ -->

<script setup lang="ts">
import { computed, watch, nextTick } from 'vue'
import { noop } from 'lodash-es'
import { useHeader } from '#mobile/composables/useHeader.ts'
import CommonLoader from '#mobile/components/CommonLoader/CommonLoader.vue'
import { QueryHandler } from '#shared/server/apollo/handler/index.ts'
import { convertToGraphQLId } from '#shared/graphql/utils.ts'
import { useTicketView } from '#shared/entities/ticket/composables/useTicketView.ts'
import type {
  PageInfo,
  TicketArticleUpdatesSubscription,
  TicketArticleUpdatesSubscriptionVariables,
} from '#shared/graphql/types.ts'
import { getApolloClient } from '#shared/server/apollo/client.ts'
import { useStickyHeader } from '#shared/composables/useStickyHeader.ts'
import { edgesToArray } from '#shared/utils/helpers.ts'
import { useRoute } from 'vue-router'
import TicketHeader from '../components/TicketDetailView/TicketDetailViewHeader.vue'
import TicketTitle from '../components/TicketDetailView/TicketDetailViewTitle.vue'
import TicketArticlesList from '../components/TicketDetailView/ArticlesList.vue'
import TicketReplyButton from '../components/TicketDetailView/TicketDetailViewReplyButton.vue'
import { useTicketArticlesQuery } from '../graphql/queries/ticket/articles.api.ts'
import { useTicketInformation } from '../composable/useTicketInformation.ts'
import { TicketArticleUpdatesDocument } from '../graphql/subscriptions/ticketArticlesUpdates.api.ts'
import { useTicketArticlesQueryVariables } from '../composable/useTicketArticlesVariables.ts'

interface Props {
  internalId: string
}

const props = defineProps<Props>()

const ticketId = computed(() => convertToGraphQLId('Ticket', props.internalId))

const {
  ticketArticlesMin,
  markTicketArticlesLoaded,
  getTicketArticlesQueryVariables,
} = useTicketArticlesQueryVariables()

const articlesQuery = new QueryHandler(
  useTicketArticlesQuery(() => getTicketArticlesQueryVariables(ticketId.value)),
  { errorShowNotification: false },
)

const result = articlesQuery.result()

const allArticleLoaded = computed(() => {
  if (!result.value?.articles.totalCount) return false
  return result.value?.articles.edges.length < result.value?.articles.totalCount
})

const refetchArticlesQuery = (pageSize: Maybe<number>) => {
  articlesQuery.refetch({
    ticketId: ticketId.value,
    pageSize,
  })
}

const loadPreviousArticles = async () => {
  markTicketArticlesLoaded(ticketId.value)
  await articlesQuery.fetchMore({
    variables: {
      pageSize: null,
      loadDescription: false,
      beforeCursor: result.value?.articles.pageInfo.startCursor,
    },
  })
}

// When the last article is deleted, cursor has to be adjusted
//  to show newly created articles in the list (if any).
// Cursor is offset-based, so the old cursor is pointing to an unavailable article,
//  thus using the cursor for the last article of the already filtered edges.
const adjustPageInfoAfterDeletion = (nextEndCursorEdge?: Maybe<string>) => {
  const newPageInfo: Pick<PageInfo, 'startCursor' | 'endCursor'> = {}

  if (nextEndCursorEdge) {
    newPageInfo.endCursor = nextEndCursorEdge
  } else {
    newPageInfo.startCursor = null
    newPageInfo.endCursor = null
  }

  return newPageInfo
}

articlesQuery.subscribeToMore<
  TicketArticleUpdatesSubscriptionVariables,
  TicketArticleUpdatesSubscription
>(() => ({
  document: TicketArticleUpdatesDocument,
  variables: {
    ticketId: ticketId.value,
  },
  onError: noop,
  updateQuery(previous, { subscriptionData }) {
    const updates = subscriptionData.data.ticketArticleUpdates

    if (!previous.articles || updates.updateArticle) return previous

    const previousArticlesEdges = previous.articles.edges
    const previousArticlesEdgesCount = previousArticlesEdges.length

    if (updates.removeArticleId) {
      const edges = previousArticlesEdges.filter(
        (edge) => edge.node.id !== updates.removeArticleId,
      )

      const removedArticleVisible = edges.length !== previousArticlesEdgesCount

      if (removedArticleVisible && !allArticleLoaded.value) {
        refetchArticlesQuery(ticketArticlesMin.value)

        return previous
      }

      const result = {
        ...previous,
        articles: {
          ...previous.articles,
          edges,
          totalCount: previous.articles.totalCount - 1,
        },
      }

      if (removedArticleVisible) {
        const nextEndCursorEdge =
          previousArticlesEdges[previousArticlesEdgesCount - 2]

        result.articles.pageInfo = {
          ...previous.articles.pageInfo,
          ...adjustPageInfoAfterDeletion(nextEndCursorEdge.cursor),
        }
      }

      // Trigger cache garbage collection after the returned article deletion subscription
      //  updated the article list.
      nextTick(() => {
        getApolloClient().cache.gc()
      })

      return result
    }

    if (updates.addArticle) {
      const needRefetch =
        !previousArticlesEdges[previousArticlesEdgesCount - 1] ||
        updates.addArticle.createdAt <=
          previousArticlesEdges[previousArticlesEdgesCount - 1].node.createdAt

      if (!allArticleLoaded.value || needRefetch) {
        refetchArticlesQuery(null)
      } else {
        articlesQuery.fetchMore({
          variables: {
            pageSize: null,
            loadDescription: false,
            afterCursor: result.value?.articles.pageInfo.endCursor,
          },
        })
      }
    }
    return previous
  },
}))

const { ticket, liveUserList, ticketQuery, scrolledToBottom } =
  useTicketInformation()
const { isTicketEditable } = useTicketView(ticket)

const isLoadingTicket = computed(() => {
  return ticketQuery.loading().value && !ticket.value
})

const isRefetchingTicket = computed(
  () => ticketQuery.loading().value && !!ticket.value,
)

const totalCount = computed(() => result.value?.articles.totalCount || 0)

const toMs = (date: string) => new Date(date).getTime()
const articles = computed(() => {
  if (!result.value) {
    return []
  }
  const nodes = edgesToArray(result.value.articles)
  const totalCount = result.value.articles.totalCount || 0
  // description might've returned with "articles"
  const description = result.value.description?.edges[0]?.node
  if (totalCount > nodes.length && description) {
    nodes.unshift(description)
  }
  return nodes.sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt))
})

useHeader({
  title: computed(() => {
    if (!ticket.value) return ''
    const { number, title } = ticket.value
    return `#${number} - ${title}`
  }),
})

// don't scroll only if articles are already loaded when you opened the page
// and there is a saved scroll position
// otherwise if we only check the scroll position we will never scroll to the bottom
// because it can be defined when we open the page the first time
if (result.value && window.history?.state?.scroll) {
  scrolledToBottom.value = true
}

const route = useRoute()

let ignoreQuery = false

const scrollElement = (element: Element) => {
  scrolledToBottom.value = true
  element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return true
}

// scroll to the article in the hash or to the last available article
const initialScroll = async () => {
  if (route.hash) {
    const articleNode = document.querySelector(route.hash)

    if (articleNode) {
      return scrollElement(articleNode)
    }

    if (!articleNode && !ignoreQuery) {
      ignoreQuery = true
      await loadPreviousArticles()
      const node = document.querySelector(route.hash)
      if (node) {
        return scrollElement(node)
      }
    }
  }

  const internalId = articles.value[articles.value.length - 1]?.internalId
  if (!internalId) return false

  const lastArticle = document.querySelector(
    `#article-${internalId}`,
  ) as HTMLElement | null

  if (!lastArticle) return false

  return scrollElement(lastArticle)
}

if (!scrolledToBottom.value) {
  const stopScrollWatch = watch(
    () => articles.value.length,
    async () => {
      const scrolled = await initialScroll()
      if (scrolled) stopScrollWatch()
    },
    { immediate: true, flush: 'post' },
  )
}

const { stickyStyles, headerElement } = useStickyHeader([
  isLoadingTicket,
  ticket,
])
</script>

<template>
  <div
    id="ticket-header"
    ref="headerElement"
    class="relative backdrop-blur-lg"
    :style="stickyStyles.header"
  >
    <TicketHeader
      :ticket="ticket"
      :live-user-list="liveUserList"
      :loading-ticket="isLoadingTicket"
      :refetching-ticket="isRefetchingTicket"
    />
    <CommonLoader
      :loading="isLoadingTicket"
      data-test-id="loader-title"
      class="flex border-b-[0.5px] border-white/10 bg-gray-600/90 px-4 py-5"
    >
      <TicketTitle v-if="ticket" :ticket="ticket" />
    </CommonLoader>
  </div>
  <div class="flex flex-1 flex-col pb-safe-20" :style="stickyStyles.body">
    <CommonLoader
      data-test-id="loader-list"
      :loading="isLoadingTicket"
      class="mt-2"
    >
      <TicketArticlesList
        v-if="ticket"
        :ticket="ticket"
        :articles="articles"
        :total-count="totalCount"
        @load-previous="loadPreviousArticles"
      />
    </CommonLoader>
  </div>
  <TicketReplyButton v-if="isTicketEditable" class="z-10" />
</template>
