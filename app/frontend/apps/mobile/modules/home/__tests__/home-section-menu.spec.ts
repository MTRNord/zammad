// Copyright (C) 2012-2022 Zammad Foundation, https://zammad-foundation.org/

import { waitFor } from '@testing-library/vue'
import { visitView } from '@tests/support/components/visitView'
import { waitForNextTick } from '@tests/support/utils'

describe('testing home section menu', () => {
  it('home icon is highlighted on home page', async () => {
    const view = await visitView('/')

    const ticketOverviewLink = view.getByRole('link', {
      name: 'Ticket Overviews',
    })

    await view.events.click(ticketOverviewLink)

    await waitForNextTick(true)

    await waitFor(() => {
      // TODO: Switch to better identifier, when real ticket lists exists.
      expect(view.getByText('Go to link Home')).toBeInTheDocument()
    })
  })
})
