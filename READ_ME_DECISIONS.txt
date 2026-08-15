

Tech stack

FE : TypeScript html css : these are well established front end tools that have the potential for large front end libraries that i could use in this current coding session or in the future. 

BE: Python with fastapi and uvvicorn : The idea with the stack is that most of the computation will occur in the DB the python is a middle man serving data from the ui to inform what info it needs form the mongo and simply passes it on the the FE

DB: There were many good candidates, grafani loki , postgresql but i felt mongo was the best choice for the limited time i had in this session it integrates with python well and is easy to standup in a docker container
    Other reasons included the fact that the data put into mongo could change. I made the assumption that the manufacturing logs are 100% in their final form that the data in them could change and monogo with python is very adaptable
    if the data changed later on mongo could accept that and our stack remains backwards compatible with old vs new data. This allows us to iterate quickly and move forward
    Once the logs format become more finalized id like to look into other more peerformant dbs for hadnling massive logs ingestion and serving

Cloud: I decided to go with GCP, its ease of using and documentation allowed me to remove a possibly signifcant headache and blocker for this assignment
        I set up my local credneital and could deploy from the command line. I decided to create the docker image locally then transfer as its a smaller amount of dat ato transfer
        The DB is created once the docker is deployed to the google cloud db and seeded buy the finalized
        I opted for the minumum memoery and cpus on this machine as its likely there will only be a handful of viewers in the future this app could scale by allocating and reqeusting more cpiu and ram 
        This is simple and allows this to scale

Another advantage of this stack is it is performant and gives us all of the functionality we need 
but it allowed me to stand up the core framework somewhat easily and could then focus on analysiing the logs and determine new features that would be of use

Features:
    User sign in 
        each page will expect a promise which either accepts the user token/cookie and sign in automaticlly or prompt the user to sign in 
    logs page: 
        This is a simple logs display page, i had imaged cusomters could view it limited to their sign in an cusomter id but also made it useful for internal developers who can have admin access and see everything
        we can filter by 
            machine_id
            customers
            materials
            time stamps beg to end
            facility 
            event types 
            parts
        the meta data button was made as the meta data seemed to vary so allowing the user to view the meta data json seemed the best temporary choice
        the raw log is useful for developers possibly to see the log in its entierty (preference)

    Flow
        This page allows the user to choose a part (customer as well maybe show them a simplified version of this) to see the progress as well as internal enginerers
        once the part is selcted its a summary of all jobs for that part, the ndes represents events and the lines connecting them get thicker according to the count of these events
        it also gives a summary of the percentage of the job completed overall

        job specific to that part have detailed nodes showing the flow, this is created by returning the logs ordered by timestamp and job id and part id 
        this gives details into specifics of how a particular job performed for that part
        THe user can clicke the node in this job and see details
        Additionally the  user can clikc to see the logs specific to that event which they are tehn routed back to the logs page with the filters applied

        The overall concept here is to utilize the data to have a presentable useful (hopefully) display of what is happening to a part and its progrress

Follow ons: 

    Cusomters: 
        customer users: give them a login so the filter of customer_id is applied at all times
    Secutiry: 
        didnt really have time to consider ddos cors or targeted attacks would be worth coming back to 
    Scaling: 
        gcp could scale quite well as we increase our hardware usage
        using a db hostin like AWS would allow us to send data and all scaling an dpreservation of data is maintined by them
    BE language: 
        with the flow page there is a bit more coputation that i wanted on the server so possible switch to GO or C# as they can handle computation alot faster
        woudl want to do a follow on analysis to confirm